#!/usr/bin/env node
/**
 * Concord spam bot — moderation-UX test harness.
 *
 * Two modes:
 *
 * CHAT (default): joins a Concord community from an invite link and posts a
 * continuous stream of gibberish spam ("test", "gggg", "nn"…) to its public
 * channels, each message collecting ❤️👍😂 from sibling keys. Strategy evolved
 * against src/concord/lib/floodCluster.ts through two rounds:
 *   - v1 content rules (density/echo/arrival-burst) were beaten by a warm
 *     48-key pool + a Jaccard-guarded unique-content engine.
 *   - v2 (commit 0cb74b2e) added a content-free COHORT rule — keys chained
 *     arrival-to-arrival (≤10 min) that drown the channel — which folds the
 *     v1 pool at 89-99%. Beaten here by introducing keys one per 11–14 min
 *     (no chain ever forms; the rule needs ≥3 chained keys), never repeating
 *     a gibberish shape within 10 min (density), and staying wordless (echo).
 * Re-run the proof against the shipped rule: node scratch/verify-evasion.mjs
 *
 * INVITE (`--invite-spam <pubkey|npub>`): NIP-59 gift-wraps kind-3313 direct
 * invites (CORD-05 §6) to a target pubkey, delivered to the target's kind-10050
 * DM relays (else NIP-65 read relays, else the stock set). ~1 in 4 invites is
 * for the real community (accept works); the rest point at freshly generated
 * PHANTOM communities (self-certifying owner+salt, random root) so the
 * recipient's already-member and declined-tombstone suppression never engages
 * and every invite parks a new dialog.
 *
 * All spam URLs use RFC 2606 reserved domains (*.example.com / *.invalid) so
 * nothing posted is actually dangerous.
 *
 * Usage:
 *   node scripts/spambot.mjs <invite-url> [options]
 *
 * The invite URL may also come from the ARMADA_INVITE env var or from
 * ~/.config/armada-spambot/invite (in that priority order).
 *
 * Options:
 *   --interval-ms <n>        Delay between messages/invites (default 3000)
 *   --invite-spam <pubkey>   Send direct invites to this key instead of chat spam
 *   --resolve-only           Resolve the invite, print community + channels, exit
 *   --once                   Post a single message, verify it reads back, exit
 *   --channel <name>         Target this channel by name for --once (default: first)
 *   --future-skew <secs>     Stamp posted messages this many seconds in the FUTURE
 *                            (a desynced/deliberate future-date, to exercise the
 *                            receiver hold + the "time traveler" moderation flag)
 *
 * Stop: Ctrl-C, or `systemctl --user stop armada-spambot` when running under
 * the bundled systemd unit.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import {
  getConversationKey,
  encrypt as nip44Encrypt,
  decrypt as nip44Decrypt,
} from "nostr-tools/nip44";
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// CORD-02 Appendix A key derivations (mirrors src/concord/lib/derive.ts)
// ---------------------------------------------------------------------------

const te = new TextEncoder();
const td = new TextDecoder();
const ZERO32 = new Uint8Array(32);

const KIND_INVITE_BUNDLE = 33301;
const KIND_WRAP = 1059;
const KIND_SEAL_ENCRYPTED = 20013;
const KIND_SEAL_PLAINTEXT = 20014;
const KIND_CHAT = 9;
const KIND_EDITION = 3308;
const KIND_GUESTBOOK = 3306;
const KIND_AUTH = 22242;
const KIND_PROFILE = 0;
const KIND_DIRECT_INVITE = 3313;
const KIND_NIP59_SEAL = 13;
const KIND_DM_RELAYS = 10050;
const KIND_RELAY_LIST = 10002;
const KIND_REACTION = 7;

const VSK_INVITE_LIVE = "6";
const VSK_INVITE_REVOKED = "9";

const RELAY_DICTIONARY = {
  1: "wss://jskitty.com/nostr",
  2: "wss://asia.vectorapp.io/nostr",
  3: "wss://relay.ditto.pub",
  4: "wss://relay.dreamith.to",
};
const STOCK_RELAYS = Object.values(RELAY_DICTIONARY);

function buildInfo(label, id32, epoch) {
  const l = te.encode(label);
  const out = new Uint8Array(l.length + 1 + 32 + (epoch !== undefined ? 8 : 0));
  out.set(l, 0);
  out[l] = 0;
  out.set(id32, l.length + 1);
  if (epoch !== undefined) {
    new DataView(out.buffer).setBigUint64(l.length + 33, BigInt(epoch), false);
  }
  return out;
}

const hkdf32 = (ikm, info) => hkdf(sha256, ikm, new Uint8Array(0), info, 32);

function hkdfToSecretKey(ikm, baseInfo) {
  const first = hkdf32(ikm, baseInfo);
  if (secp256k1.utils.isValidSecretKey(first)) return first;
  for (let c = 0; c <= 0xff; c++) {
    const info = new Uint8Array([...baseInfo, c]);
    const seed = hkdf32(ikm, info);
    if (secp256k1.utils.isValidSecretKey(seed)) return seed;
  }
  throw new Error("unreachable: no valid secret key in 257 HKDF rounds");
}

function groupKey(secretHex, label, idHex, epoch) {
  const sk = hkdfToSecretKey(
    hexToBytes(secretHex),
    buildInfo(label, hexToBytes(idHex), BigInt(epoch)),
  );
  const pk = bytesToHex(schnorr.getPublicKey(sk));
  return { sk, pk, convKey: getConversationKey(sk, pk) };
}

const channelGroupKey = (rootHex, channelIdHex, epoch) =>
  groupKey(rootHex, "concord/channel", channelIdHex, epoch);
const guestbookGroupKey = (rootHex, communityIdHex, epoch) =>
  groupKey(rootHex, "concord/guestbook", communityIdHex, epoch);
const controlGroupKey = (rootHex, communityIdHex, epoch) =>
  groupKey(rootHex, "concord/control", communityIdHex, epoch);
const inviteBundleKey = (token) =>
  hkdf32(token, buildInfo("concord/invite-key", ZERO32));

function verifyCommunityId(idHex, ownerHex, saltHex) {
  return communityIdOf(ownerHex, saltHex) === idHex.toLowerCase();
}

function communityIdOf(ownerHex, saltHex) {
  const pre = new Uint8Array([
    ...te.encode("concord/community"),
    ...hexToBytes(ownerHex),
    ...hexToBytes(saltHex),
  ]);
  return bytesToHex(sha256(pre));
}

// ---------------------------------------------------------------------------
// CORD-05 invite link parsing (mirrors src/concord/lib/invite.ts)
// ---------------------------------------------------------------------------

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(
    Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64"),
  );
}

function decodeFragment(fragment) {
  const bytes = b64urlDecode(fragment.trim());
  let o = 0;
  if (bytes[o++] !== 4) throw new Error("unsupported fragment version");
  const flags = bytes[o++];
  const relays = [];
  if (flags & 1) {
    relays.push(...STOCK_RELAYS);
  } else {
    const count = bytes[o++];
    for (let i = 0; i < count; i++) {
      const lead = bytes[o++];
      if (lead >= 1 && lead <= 254) {
        if (RELAY_DICTIONARY[lead]) relays.push(RELAY_DICTIONARY[lead]);
      } else {
        const len = bytes[o++];
        const text = td.decode(bytes.slice(o, o + len));
        o += len;
        relays.push(lead === 255 ? text : `wss://${text}`);
      }
    }
  }
  const token = bytes.slice(o, o + 16);
  o += 16;
  if (token.length !== 16 || o !== bytes.length) {
    throw new Error("malformed fragment");
  }
  return { token, relays };
}

function parseInvite(url) {
  const u = new URL(url);
  const naddr = decodeURIComponent(
    u.pathname.replace(/^\/invite\//, "").replace(/\/$/, ""),
  );
  const d = nip19.decode(naddr);
  if (d.type !== "naddr" || d.data.kind !== KIND_INVITE_BUNDLE || d.data.identifier !== "") {
    throw new Error("not a Concord invite link");
  }
  const { token, relays } = decodeFragment(u.hash.slice(1));
  return { linkSigner: d.data.pubkey, token, bootstrapRelays: relays, naddr };
}

// ---------------------------------------------------------------------------
// CORD-01 seal + wrap construction (mirrors src/concord/lib/stream.ts)
// ---------------------------------------------------------------------------

function buildRumor({ kind, content, tags, pubkey, ms }) {
  const t = [...tags, ["ms", String(Math.floor(ms) % 1000)]];
  const unsigned = { kind, content, tags: t, created_at: Math.floor(ms / 1000), pubkey };
  return { ...unsigned, id: getEventHash(unsigned) };
}

function sealAndWrap(rumor, stream, authorSk) {
  const seal = finalizeEvent(
    {
      kind: KIND_SEAL_ENCRYPTED,
      content: nip44Encrypt(JSON.stringify(rumor), stream.convKey),
      tags: [],
      created_at: rumor.created_at,
    },
    authorSk,
  );
  return finalizeEvent(
    {
      kind: KIND_WRAP,
      content: nip44Encrypt(JSON.stringify(seal), stream.convKey),
      tags: [["p", getPublicKey(generateSecretKey())]],
      created_at: Math.floor(Date.now() / 1000),
    },
    stream.sk,
  );
}

// ---------------------------------------------------------------------------
// Minimal relay pool with NIP-42 auth (ditto-relay gates kind 1059)
// ---------------------------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

class RelayConn {
  constructor(url, getAuthSigners) {
    this.url = url;
    this.getAuthSigners = getAuthSigners;
    this.ws = null;
    this.subs = new Map(); // subId -> {onEvent, onEose}
    this.okWaiters = new Map(); // eventId -> {resolve, timer}
    this.challenge = undefined;
    this.dead = false;
  }

  connect(timeoutMs = 10000) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    this.dead = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error(`connect timeout ${this.url}`));
      }, timeoutMs);
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`ws error ${this.url}: ${e.message ?? "error"}`));
      });
      ws.addEventListener("close", () => {
        this.dead = true;
        for (const [, sub] of this.subs) sub.onEose?.("closed");
        this.subs.clear();
        for (const [id, w] of this.okWaiters) {
          clearTimeout(w.timer);
          w.resolve({ ok: false, message: "connection closed" });
          this.okWaiters.delete(id);
        }
      });
      ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    });
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    switch (msg[0]) {
      case "AUTH": {
        this.challenge = msg[1];
        this.sendAuth();
        break;
      }
      case "OK": {
        const [, id, ok, message] = msg;
        const w = this.okWaiters.get(id);
        if (w) {
          clearTimeout(w.timer);
          this.okWaiters.delete(id);
          w.resolve({ ok, message: message ?? "" });
        }
        break;
      }
      case "EVENT": {
        const sub = this.subs.get(msg[1]);
        sub?.onEvent?.(msg[2]);
        break;
      }
      case "EOSE": {
        const sub = this.subs.get(msg[1]);
        this.subs.delete(msg[1]);
        sub?.onEose?.("eose");
        break;
      }
      case "CLOSED": {
        const sub = this.subs.get(msg[1]);
        this.subs.delete(msg[1]);
        sub?.onEose?.(`closed: ${msg[2] ?? ""}`);
        break;
      }
      case "NOTICE":
        log(`NOTICE ${this.url}: ${msg[1]}`);
        break;
    }
  }

  sendAuth() {
    if (!this.challenge) return;
    const seen = new Set();
    for (const sk of this.getAuthSigners()) {
      const pk = getPublicKey(sk);
      if (seen.has(pk)) continue;
      seen.add(pk);
      const auth = finalizeEvent(
        {
          kind: KIND_AUTH,
          content: "",
          tags: [
            ["relay", this.url],
            ["challenge", this.challenge],
          ],
          created_at: Math.floor(Date.now() / 1000),
        },
        sk,
      );
      this.send(["AUTH", auth]);
    }
  }

  send(frame) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  request(filter, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const subId = `s${Math.random().toString(36).slice(2, 12)}`;
      const events = [];
      const timer = setTimeout(() => {
        this.subs.delete(subId);
        this.send(["CLOSE", subId]);
        resolve(events);
      }, timeoutMs);
      this.subs.set(subId, {
        onEvent: (ev) => events.push(ev),
        onEose: () => {
          clearTimeout(timer);
          resolve(events);
        },
      });
      this.send(["REQ", subId, filter]);
    });
  }

  publish(event, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.okWaiters.delete(event.id);
        resolve({ ok: false, message: "timeout waiting for OK" });
      }, timeoutMs);
      this.okWaiters.set(event.id, { resolve, timer });
      this.send(["EVENT", event]);
    });
  }

  close() {
    this.dead = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

class RelayPool {
  constructor(getAuthSigners) {
    this.conns = new Map();
    this.extraSigners = []; // mutable ring (e.g. invite-mode ephemeral keys)
    this.getAuthSigners = () => [...getAuthSigners(), ...this.extraSigners];
  }

  async get(url) {
    let conn = this.conns.get(url);
    if (!conn || conn.dead) {
      conn?.close();
      conn = new RelayConn(url, this.getAuthSigners);
      this.conns.set(url, conn);
      await conn.connect();
    }
    return conn;
  }

  /** Publish to all urls; resolves on first acceptance. */
  async publishToAny(urls, event) {
    const results = await Promise.allSettled(
      urls.map(async (url) => {
        const conn = await this.get(url);
        const res = await conn.publish(event);
        if (!res.ok && res.message.startsWith("auth-required")) {
          conn.sendAuth();
          return conn.publish(event);
        }
        return res;
      }),
    );
    const accepted = results.find(
      (r) => r.status === "fulfilled" && r.value.ok,
    );
    if (accepted) return { ok: true, message: accepted.value.message };
    const reasons = results
      .map((r) =>
        r.status === "fulfilled" ? r.value.message : String(r.reason),
      )
      .join(" | ");
    return { ok: false, message: reasons };
  }

  /** Query urls with filter, merge + dedupe by id, until EOSE/timeout. */
  async queryAll(urls, filter, timeoutMs = 15000) {
    const results = await Promise.allSettled(
      urls.map(async (url) => (await this.get(url)).request(filter, timeoutMs)),
    );
    const byId = new Map();
    for (const r of results) {
      if (r.status === "fulfilled") {
        for (const ev of r.value) byId.set(ev.id, ev);
      }
    }
    return [...byId.values()];
  }

  closeAll() {
    for (const conn of this.conns.values()) conn.close();
    this.conns.clear();
  }
}

// ---------------------------------------------------------------------------
// Bundle resolution + channel discovery
// ---------------------------------------------------------------------------

async function resolveBundle(pool, invite) {
  const filter = {
    kinds: [KIND_INVITE_BUNDLE],
    authors: [invite.linkSigner],
    "#d": [""],
    limit: 5,
  };
  let events = await pool.queryAll(invite.bootstrapRelays, filter);
  if (events.length === 0 && !invite.bootstrapRelays.every((r) => STOCK_RELAYS.includes(r))) {
    events = await pool.queryAll(STOCK_RELAYS, filter);
  }
  events = events.filter(verifyEvent).sort((a, b) => b.created_at - a.created_at);
  for (const event of events) {
    const vsk = event.tags.find((t) => t[0] === "vsk")?.[1];
    if (vsk === VSK_INVITE_REVOKED) throw new Error("invite link has been revoked");
    if (vsk !== VSK_INVITE_LIVE) continue;
    const bundle = JSON.parse(nip44Decrypt(event.content, inviteBundleKey(invite.token)));
    if (!verifyCommunityId(bundle.community_id, bundle.owner, bundle.owner_salt)) {
      throw new Error("bundle community_id mismatch");
    }
    return bundle;
  }
  throw new Error("no live invite bundle found on bootstrap relays");
}

/** Fold the control plane and return public, non-deleted channels. */
async function discoverChannels(pool, bundle) {
  // The control plane has split read/write keys. Post-split, the wrap AUTHOR is
  // the delivered `control_pk` (a control_root-derived signer a joiner can't
  // derive), while the wraps are still decrypted under the community_root read
  // key. Pre-split (LEGACY), `control_pk` is absent and its ABSENCE means the
  // read key's own pubkey IS the address — derivable from the bundle alone.
  // Mirrors controlViewFromBundle() in src/concord/lib/discoverControlPeek.ts.
  const readKey = controlGroupKey(bundle.community_root, bundle.community_id, bundle.root_epoch);
  const isSplit = typeof bundle.control_pk === "string" && /^[0-9a-f]{64}$/i.test(bundle.control_pk);
  const controlAuthor = isSplit ? bundle.control_pk.toLowerCase() : readKey.pk;
  const wraps = await pool.queryAll(
    bundle.relays,
    { kinds: [KIND_WRAP], authors: [controlAuthor] },
    45000,
  );
  if (process.env.DEBUG_BUNDLE === "1") {
    log(`discoverChannels: ${isSplit ? "split" : "legacy"} author=${controlAuthor.slice(0, 12)}… raw wraps from relays: ${wraps.length}`);
  }
  const editions = new Map(); // eid -> {ev, vsk, content}
  for (const wrap of wraps) {
    if (wrap.pubkey !== controlAuthor || !verifyEvent(wrap)) continue;
    try {
      const seal = JSON.parse(nip44Decrypt(wrap.content, readKey.convKey));
      if (seal.kind !== KIND_SEAL_PLAINTEXT) continue;
      const rumor = JSON.parse(seal.content);
      if (rumor.kind !== KIND_EDITION) continue;
      const tag = (n) => rumor.tags.find((t) => t[0] === n)?.[1];
      const vsk = tag("vsk");
      const eid = tag("eid");
      const ev = Number(tag("ev"));
      if (!vsk || !eid || !Number.isFinite(ev)) continue;
      const prev = editions.get(eid);
      if (!prev || ev > prev.ev) editions.set(eid, { ev, vsk, content: rumor.content });
    } catch {
      // not decryptable / malformed — skip
    }
  }
  const channels = [];
  let privateSkipped = 0;
  let deletedSkipped = 0;
  // Own testing grounds sometimes have only PRIVATE channels; let a run target
  // them explicitly. The stream key derives from community_root + channel id
  // regardless of the private flag, so a post reads back the same way.
  const includePrivate = process.env.INCLUDE_PRIVATE === "1";
  for (const [eid, ed] of editions) {
    if (ed.vsk !== "2") continue;
    try {
      const def = JSON.parse(ed.content);
      if (def.deleted) { deletedSkipped += 1; continue; }
      if (def.private && !includePrivate) { privateSkipped += 1; continue; }
      channels.push({ id: eid, name: def.name ?? "channel", private: Boolean(def.private) });
    } catch {
      // skip
    }
  }
  if (channels.length === 0) {
    log(`discoverChannels: ${editions.size} edition(s), ${privateSkipped} private skipped, ${deletedSkipped} deleted (set INCLUDE_PRIVATE=1 to include private)`);
  }
  return channels;
}

// ---------------------------------------------------------------------------
// Unique-content engine (flood-fold evasion)
// ---------------------------------------------------------------------------
// src/concord/lib/floodCluster.ts folds a message when EITHER rule fires:
//   density — one shape (case/whitespace/digits/URLs normalized) repeated
//             ≥8× in 5 min, by ≤2 authors or by all-stranger authors;
//   echo    — one substantial template (≥8 words, ≥5 with a link) posted ≥4×
//             across ≥3 keys in 1h, near-duplicates merged at Jaccard ≥ 0.6;
// plus rule 3 (arrival burst) for ≥8 messages from ≥6 keys whose whole
// presence fits in 2 min. The counter is a persistent key pool (see main
// loop) and content that never repeats a shape: wide combinatorial frames
// here, with a Jaccard guard against the last hour of output as enforcement.
// All URLs stay on RFC 2606 reserved domains.

const TOKENS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "PEPE", "SHIB", "ADA", "AVAX", "LINK", "SUI", "NEAR", "ARB", "OP", "TAO"];
const URLS = [
  "https://doubler.example.com", "https://claim-airdrop.example.com", "https://verify-wallet.example.com",
  "https://signals-pro.example.com", "https://freemint.example.com", "https://bonus-pool.example.com",
  "https://prize-draw.example.com", "https://elon-giveaway.example.com", "https://pump-alerts.example.com",
  "https://wallet-sync.example.com", "https://node-rewards.example.com", "https://stake-max.example.com",
];
const NAMES = ["Sarah", "CryptoKing", "Jessica", "Mike", "Luna", "Dave", "Priya", "Victor", "Nina", "Omar", "Elena", "Marcus", "Tara", "Ken"];
const TOPICS = [
  "the halving aftermath", "restaking yields", "the new L2 launch", "airdrop meta", "ETF inflows",
  "memecoin rotation", "validator queue times", "MEV protection", "the governance proposal",
  "liquidity incentives", "perp funding rates", "the bridge audit", "stablecoin yields",
  "the token unlock schedule", "onchain volume", "the dev relaunch", "gas optimization",
  "the testnet migration",
];
const RELATIVES = ["cousin", "neighbor", "brother in law", "old college friend", "coworker", "gym buddy", "landlord", "barber", "dentist", "roommate", "uncle", "former manager"];
const EARN_VERBS = ["turned {small} into {big}", "flipped {small} to {big}", "grew a {small} bag to {big}", "cleared {big} starting from {small}", "netted {big} off a {small} position"];
const ASSET_ACTS = ["staking", "swinging", "DCAing into", "farming", "validating", "lp'ing", "holding", "accumulating", "bridging", "restaking"];
const TOOLS = ["dashboard", "aggregator", "vault", "tracker", "screener", "simulator", "explorer", "index", "scanner", "portfolio tool"];
const TOOL_ADJ = ["free", "open-source", "community-run", "audited", "beta", "invite-only", "non-custodial", "cross-chain", "zero-fee", "privacy-first"];
const OPENERS = [
  "hey everyone", "hi all", "good morning folks", "hello frens", "hey gang", "evening all",
  "hola amigos", "hey folks", "quick question", "not financial advice but", "serious question",
  "random thought", "ok so", "real talk", "unpopular opinion", "honest question",
];
const QUESTIONS = [
  "what is everyone {act} this {when}?", "is {t} still worth {act} after {topic}?",
  "anyone else {watch} {topic} {when}?", "thoughts on {t} versus {t2} {when}?",
  "when do we realistically see {t} move again?", "did anyone here catch the news about {topic}?",
  "what am I missing about {topic}?", "is it too late to get into {t}?",
  "how is everyone playing {topic}?", "anyone tried that {adj} {t} {tool} yet?",
  "what wallets are you all using for {t} {when}?", "who here is still {act} {t}, worth the gas?",
];
const WATCH = ["watching", "tracking", "following", "farming", "monitoring", "studying"];
const WHEN = ["this week", "lately", "these days", "this month", "right now", "this cycle"];
const SMALL = ["fifty bucks", "a couple hundred", "one paycheck", "spare change", "a small bag", "lunch money", "two hundred"];
const BIG = ["a used car", "five figures", "a house deposit", "a year of rent", "six months of salary", "a motorcycle", "tuition money"];
const CTAS = [
  "do your own research obviously", "link is in my bio if anyone wants it", "happy to share details in DMs",
  "not going to post the link here, mods are touchy", "look it up before you disagree", "dyor as always",
  "I can point you to the {tool} if you ask nicely", "check my profile for the writeup",
];
const ALERTS = [
  "heads up", "PSA for everyone here", "be careful out there", "friendly warning", "just so nobody else gets burned",
  "not sure who needs to hear this", "important reminder", "saw this too many times {when}",
];
const WARNINGS = [
  "a fake {t} support account is going around asking for seed phrases",
  "there is a phishing site cloning the official {t} staking page",
  "someone is impersonating mods in DMs asking about {topic}",
  "a fake airdrop for {t} is draining wallets that sign the claim",
  "a lookalike bridge around {topic} popped up, double check URLs",
  "people are getting wallet-drained by a fake {t} rewards portal",
  "a cloned {tool} is stealing keys, the real one never asks for your seed",
  "romance scammers are pitching {t} schemes in DMs again",
];
const OFFERS = [
  "there is still a rewards pool open for {t} holders, claiming ends {when}: {url}",
  "found a {adj} {tool} paying way over market for {t}, been live for weeks: {url}",
  "the {t} foundation is doing a loyalty airdrop, check eligibility here: {url}",
  "this {adj} {tool} tracks {topic} wallets, still in beta: {url}",
  "a validator I use is boosting {t} rewards {when}, no lockup: {url}",
  "there is a community voting portal for {topic} with a small grant attached: {url}",
  "my referral for the {t} yield {tool} still has slots, we split the bonus: {url}",
  "new {t} {tool} is dripping credits if you are quick: {url}",
];
const STORIES = [
  "I finally moved my {t} off the exchange after reading about {topic}",
  "been {act} {t} since last year and it adds up faster than you think",
  "lost some {t} to a phishing site last month so now I triple check every link",
  "my portfolio is basically {t} and hopes at this point",
  "spent the weekend reading about {topic} and I am convinced we are early",
  "I keep telling my {rel} to look at {topic} before it is everywhere",
  "watched {t} dip twice {when} and bought both times, no regrets",
  "my thesis on {topic} has not changed in months, just quietly {act} {t}",
  "sold my {t} bag too early once and never forgave myself",
  "set up a small {t} validator and the rewards are actually decent",
  "my {rel} would not stop talking about {topic} at dinner",
  "switched my {t} over to a {adj} {tool} after the fees got silly",
];
const CLAIMS = [
  "my {rel} {earn} on {t}", "a guy I work with {earn} off {topic}",
  "my {rel} quit her job after {act} {t} all year", "this trader I follow called {topic} a week early",
  "an old {rel} made {big} {act} {t}", "my {rel} got into {topic} before anyone I know",
  "a small account I follow {earn} on {t}", "my {rel} would not stop texting me about {topic}",
  "a group chat I am in has been printing on {t} all month", "someone at my gym {earn} off {topic}",
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const maybe = (p) => Math.random() < p;

function fill(s, token) {
  // NB: {earn} expands lazily — replaceAll would evaluate the recursive fill
  // call even when the pattern is absent, recursing forever.
  if (s.includes("{earn}")) s = s.replaceAll("{earn}", fill(pick(EARN_VERBS), token));
  return s
    .replaceAll("{t}", token)
    .replaceAll("{t2}", pick(TOKENS))
    .replaceAll("{topic}", pick(TOPICS))
    .replaceAll("{url}", pick(URLS))
    .replaceAll("{name}", pick(NAMES))
    .replaceAll("{rel}", pick(RELATIVES))
    .replaceAll("{small}", pick(SMALL))
    .replaceAll("{big}", pick(BIG))
    .replaceAll("{act}", pick(ASSET_ACTS))
    .replaceAll("{tool}", pick(TOOLS))
    .replaceAll("{adj}", pick(TOOL_ADJ))
    .replaceAll("{watch}", pick(WATCH))
    .replaceAll("{when}", pick(WHEN));
}

/** One unique-looking chat message; long, link in ~40%. (English engine.) */
export function generateMessage() {
  const token = pick(TOKENS);
  const frames = [
    () => `${pick(OPENERS)}, ${fill(pick(QUESTIONS), token)}`,
    () => `${fill(pick(QUESTIONS), token)} ${fill(pick(CTAS), token)}.`,
    () => `${fill(pick(CLAIMS), token)} {when} — ${fill(pick(CTAS), token)}.`,
    () => `${pick(OPENERS)}! ${fill(pick(STORIES), token)}.`,
    () => `${fill(pick(STORIES), token)}. ${fill(pick(CTAS), token)}, {when}.`,
    () => `${pick(ALERTS)}: ${fill(pick(WARNINGS), token)}${maybe(0.5) ? `: ${pick(URLS)}` : ""}`,
    () => `${pick(ALERTS)}, ${fill(pick(WARNINGS), token)}. stay safe {when}.`,
    () => fill(pick(OFFERS), token),
    () => `${pick(OPENERS)}, ${fill(pick(OFFERS), token)}`,
    () => `${fill(pick(CLAIMS), token)}. anyway, ${fill(pick(QUESTIONS), token)}`,
    () => {
      const story = fill(pick(STORIES), token);
      return `${fill(pick(QUESTIONS), token)} asking because ${story.charAt(0).toLowerCase()}${story.slice(1)}.`;
    },
  ];
  let msg = fill(pick(frames)(), token);
  // Occasional second sentence keeps length/shape distribution wide.
  if (maybe(0.25)) msg += ` ${fill(pick(STORIES), pick(TOKENS))}.`;
  return msg;
}

// --- Gibberish engine ------------------------------------------------------
// The current round's content: near-wordless noise in the spirit of "test",
// "teste", "nn", "gggg". Single-token shapes are echo-ineligible (<5 words),
// and with no exact shape repeating within 10 minutes the density rule never
// finds 8 copies in 5. Content rules simply have nothing to read.

const TEST_FAMILY = ["test", "teste", "sets", "sete", "tset", "tes", "tet", "tst", "tests", "testt", "sett", "est"];
const REPEAT_LETTERS = "gntsraelodhcpbmu".split("");
const GIBBERISH_CHARS = "abcdefghijklmnopqrstuvwxyz";

const recentGibberish = new Map(); // shape -> ms
function gibberishRaw() {
  const roll = Math.random();
  if (roll < 0.2) return pick(TEST_FAMILY);
  if (roll < 0.6) {
    const letter = pick(REPEAT_LETTERS);
    return letter.repeat(1 + Math.floor(Math.random() * 7));
  }
  const len = 1 + Math.floor(Math.random() * 7);
  let s = "";
  for (let i = 0; i < len; i++) s += GIBBERISH_CHARS[Math.floor(Math.random() * 26)];
  return s;
}

/** Gibberish that has not appeared in the last 10 minutes. */
export function gibberishContent() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [shape, t] of recentGibberish) if (t < cutoff) recentGibberish.delete(shape);
  for (let tries = 0; tries < 100; tries++) {
    const content = gibberishRaw();
    if (!recentGibberish.has(content)) {
      recentGibberish.set(content, Date.now());
      return content;
    }
  }
  return null; // give up the beat rather than repeat a shape
}

/** Content dispatcher: --content english|gibberish (default gibberish). */
function makeContent(opts) {
  return opts.content === "english" ? guardedContent() : gibberishContent();
}

// --- Jaccard guard for the English engine, mirroring floodCluster.ts -------
// (kept after the dispatcher textually; function declarations hoist)

const URL_RUN = /https?:\/\/\S+/g;
const TRAILING_NONCE = /([>!])\s*[a-z0-9]{4,9}$/;
const DIGIT_TOKEN = /[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*/gu;
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff]/g;
const WORD = /[\p{L}][\p{L}\p{N}_]*/gu;

export function shapeKey(content) {
  return content
    .toLowerCase()
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(URL_RUN, "@")
    .replace(TRAILING_NONCE, "$1#")
    .replace(DIGIT_TOKEN, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const recentShapes = []; // { t: ms, shape: string, words: Set<string> }
let guardGiveups = 0;

/**
 * A message strictly dissimilar (Jaccard < 0.45, well under the fold's 0.6
 * merge) from everything sent in the last hour, and never an exact shape
 * repeat — so neither the density rule nor the echo rule can ever find 8 or 4
 * copies of anything, and no two buckets ever merge into a campaign. Returns
 * null when the hour is too crowded to differentiate against (caller skips
 * the tick — a missed beat is invisible, a flagged flood is not).
 */
export function guardedContent() {
  const cutoff = Date.now() - 65 * 60 * 1000;
  while (recentShapes.length && recentShapes[0].t < cutoff) recentShapes.shift();
  for (let tries = 0; tries < 500; tries++) {
    const content = generateMessage();
    const shape = shapeKey(content);
    const words = new Set(shape.match(WORD) ?? []);
    let clash = false;
    for (const r of recentShapes) {
      if (r.shape === shape || jaccard(words, r.words) >= 0.45) { clash = true; break; }
    }
    if (!clash) {
      recentShapes.push({ t: Date.now(), shape, words });
      return content;
    }
  }
  guardGiveups++;
  return null;
}

/** Human-looking kind-0 profiles for pool keys: no bot flag, no chain. */
function humanProfile() {
  const name = pick(NAMES);
  const styles = [
    () => name,
    () => `${name}${Math.floor(Math.random() * 90) + 10}`,
    () => `${name} ${String.fromCharCode(65 + Math.floor(Math.random() * 26))}.`,
    () => name.toLowerCase(),
  ];
  const bios = [
    "building in web3", "here for the tech", "trading since 2017", "just here to learn",
    "hodling through it all", "coffee and crypto", "lurking and learning", "decentralization maxi",
    "mostly lurking", "asking too many questions", "in it for the long run", "nocoiner curious",
  ];
  return { name: pick(styles)(), about: pick(bios) };
}

/** Phantom-community names for direct-invite spam. */
const PHANTOM_NAMES = [
  "Crypto Signals Pro", "NFT Whales Lounge", "Bitcoin Millionaires Club", "Alt Gem Hunters",
  "DeFi Insiders", "Moon Shot Traders", "Airdrop Alpha Group", "Whale Watch Daily",
  "Trading Mastery Hub", "Passive Income Network", "Pump Squad Elite", "Web3 Jobs Board",
  "Staking Rewards Club", "Memecoin Mania", "The Hodl Hotel",
];

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

function decodePubkey(s) {
  if (!s) throw new Error("--invite-spam needs a pubkey argument");
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  const d = nip19.decode(s);
  if (d.type === "npub") return d.data;
  if (d.type === "nprofile") return d.data.pubkey;
  throw new Error(`not a pubkey/npub/nprofile: ${s}`);
}

function parseArgs(argv) {
  const opts = { intervalMs: 3000, content: "gibberish", once: false, resolveOnly: false, invite: undefined, inviteSpam: undefined, futureSkewSecs: 0 };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    switch (a) {
      case "--interval-ms":
        opts.intervalMs = Number(args.shift());
        break;
      case "--content": {
        const v = args.shift();
        if (v !== "english" && v !== "gibberish") throw new Error("--content must be english|gibberish");
        opts.content = v;
        break;
      }
      case "--future-skew":
        // Stamp posted chat messages this many SECONDS ahead of the real clock
        // (a desynced sender / deliberate future-date). Exercises the receiver
        // hold + the "TIME TRAVELER DETECTED" moderation flag.
        opts.futureSkewSecs = Number(args.shift());
        if (!Number.isFinite(opts.futureSkewSecs)) throw new Error("--future-skew must be a number of seconds");
        break;
      case "--channel":
        // Target a specific channel by name (case-insensitive) for --once.
        opts.channel = args.shift();
        break;
      case "--invite-spam":
        opts.inviteSpam = decodePubkey(args.shift());
        break;
      case "--once":
        opts.once = true;
        break;
      case "--resolve-only":
        opts.resolveOnly = true;
        break;
      default:
        if (a?.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        opts.invite = a;
    }
  }
  if (!opts.invite) opts.invite = process.env.ARMADA_INVITE;
  if (!opts.invite) {
    try {
      opts.invite = readFileSync(join(homedir(), ".config", "armada-spambot", "invite"), "utf8").trim();
    } catch {
      /* no invite file */
    }
  }
  if (!opts.invite) {
    throw new Error("no invite: pass the invite URL as an argument, set ARMADA_INVITE, or write it to ~/.config/armada-spambot/invite");
  }
  if (!(opts.intervalMs > 0)) throw new Error("interval must be positive");
  return opts;
}

let identityCounter = 0;

function newIdentity() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), index: ++identityCounter };
}

/**
 * Announce a pool key with a kind-0 profile. Deliberately human-looking and
 * unlinkable (no bot flag, no instance id, no chain to the previous key):
 * anything else would hand the defender a signal the flood fold doesn't read.
 * The bot's own log records every key for correlation.
 */
async function publishProfile(pool, relays, identity) {
  const event = finalizeEvent(
    {
      kind: KIND_PROFILE,
      content: JSON.stringify(humanProfile()),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    identity.sk,
  );
  return pool.publishToAny(relays, event);
}

// ---------------------------------------------------------------------------
// CORD-05 §6 direct invites (mirrors src/concord/lib/directInvite.ts)
// ---------------------------------------------------------------------------

/** NIP-59 timestamp fuzzing: now minus a random 0..48h. */
const tweakedPast = () =>
  Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 2 * 24 * 60 * 60);

/**
 * A bundle for a community that does not exist: random owner key + salt make
 * the self-certifying community_id check pass, random root/control keys are
 * never validated on receive. Each phantom invite is a NEW community_id, so
 * already-member suppression and decline-tombstones never catch a second one.
 */
function phantomBundle(name, inviterPk) {
  const owner = getPublicKey(generateSecretKey());
  const salt = bytesToHex(generateSecretKey());
  return {
    community_id: communityIdOf(owner, salt),
    owner,
    owner_salt: salt,
    community_root: bytesToHex(generateSecretKey()),
    root_epoch: 0,
    control_pk: getPublicKey(generateSecretKey()),
    channels: [],
    relays: [...STOCK_RELAYS],
    name,
    description: `The official ${name} community. Invite-only alpha, join before it fills up.`,
    creator_npub: inviterPk,
  };
}

/** A real, acceptable invite to the community the bot holds a link for. */
function memberBundle(source, inviterPk) {
  return {
    community_id: source.community_id,
    owner: source.owner,
    owner_salt: source.owner_salt,
    community_root: source.community_root,
    root_epoch: source.root_epoch,
    ...(source.control_pk ? { control_pk: source.control_pk } : {}),
    channels: source.channels ?? [],
    relays: source.relays,
    name: source.name,
    ...(source.description ? { description: source.description } : {}),
    creator_npub: inviterPk,
  };
}

/**
 * wrap(1059, ephemeral) → seal(13, inviter) → rumor(3313, bundle JSON),
 * classic NIP-59. The wrap carries the recipient `p` and the `k=3313` hint.
 */
function buildDirectInviteWrap(recipientPk, bundle, inviterSk) {
  const inviterPk = getPublicKey(inviterSk);
  const rumor = {
    kind: KIND_DIRECT_INVITE,
    content: JSON.stringify(bundle),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: inviterPk,
  };
  const seal = finalizeEvent(
    {
      kind: KIND_NIP59_SEAL,
      content: nip44Encrypt(JSON.stringify(rumor), getConversationKey(inviterSk, recipientPk)),
      tags: [],
      created_at: tweakedPast(),
    },
    inviterSk,
  );
  const eph = generateSecretKey();
  const wrap = finalizeEvent(
    {
      kind: KIND_WRAP,
      content: nip44Encrypt(JSON.stringify(seal), getConversationKey(eph, recipientPk)),
      tags: [
        ["p", recipientPk],
        ["k", String(KIND_DIRECT_INVITE)],
      ],
      created_at: tweakedPast(),
    },
    eph,
  );
  return { wrap, eph, inviterPk };
}

/** Recipient's inbox: kind-10050 DM relays → NIP-65 read relays → stock set. */
async function resolveInboxRelays(pool, recipientPk) {
  const events = await pool.queryAll(
    STOCK_RELAYS,
    { kinds: [KIND_DM_RELAYS, KIND_RELAY_LIST], authors: [recipientPk], limit: 4 },
    8000,
  );
  const latest = (kind) =>
    events.filter((e) => e.kind === kind).sort((a, b) => b.created_at - a.created_at)[0];
  const norm = (u) => {
    if (typeof u !== "string") return undefined;
    u = u.trim();
    if (!u) return undefined;
    if (!/^wss?:\/\//.test(u)) u = `wss://${u}`;
    return u.replace(/\/+$/, "");
  };
  const dm = latest(KIND_DM_RELAYS);
  if (dm) {
    const relays = dm.tags.filter((t) => t[0] === "relay").map((t) => norm(t[1])).filter(Boolean);
    if (relays.length) return relays.slice(0, 5);
  }
  const nip65 = latest(KIND_RELAY_LIST);
  if (nip65) {
    const relays = nip65.tags
      .filter((t) => t[0] === "r" && t[2] !== "write")
      .map((t) => norm(t[1]))
      .filter(Boolean);
    if (relays.length) return relays.slice(0, 5);
  }
  return [...STOCK_RELAYS];
}

async function postChat(pool, bundle, channel, identity, content, skewSecs = 0) {
  const stream = channelGroupKey(bundle.community_root, channel.id, bundle.root_epoch);
  const rumor = buildRumor({
    kind: KIND_CHAT,
    content,
    tags: [
      ["channel", channel.id],
      ["epoch", String(bundle.root_epoch)],
    ],
    pubkey: identity.pk,
    ms: Date.now() + skewSecs * 1000,
  });
  const wrap = sealAndWrap(rumor, stream, identity.sk);
  return { wrap, rumor, result: await pool.publishToAny(bundle.relays, wrap) };
}

async function guestbookJoin(pool, bundle, identity) {
  const gb = guestbookGroupKey(bundle.community_root, bundle.community_id, bundle.root_epoch);
  const rumor = buildRumor({
    kind: KIND_GUESTBOOK,
    content: "join",
    tags: [],
    pubkey: identity.pk,
    ms: Date.now(),
  });
  const wrap = sealAndWrap(rumor, gb, identity.sk);
  return pool.publishToAny(bundle.relays, wrap);
}

/** NIP-25-style reaction rumor (kind 7), same seal/wrap path as chat. */
async function postReaction(pool, bundle, channel, reactor, targetRumorId, targetAuthorPk, emoji) {
  const stream = channelGroupKey(bundle.community_root, channel.id, bundle.root_epoch);
  const rumor = buildRumor({
    kind: KIND_REACTION,
    content: emoji,
    tags: [
      ["channel", channel.id],
      ["epoch", String(bundle.root_epoch)],
      ["e", targetRumorId],
      ["p", targetAuthorPk],
    ],
    pubkey: reactor.pk,
    ms: Date.now(),
  });
  const wrap = sealAndWrap(rumor, stream, reactor.sk);
  return pool.publishToAny(bundle.relays, wrap);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Direct-invite spam loop
// ---------------------------------------------------------------------------

async function inviteLoop(pool, invite, bundle, recipientPk, opts) {
  // Ephemeral wrap authors need to answer NIP-42 challenges on gated relays;
  // keep the most recent ones in the pool's auth set.
  const ephRing = [];
  pool.extraSigners = ephRing;

  let inbox = await resolveInboxRelays(pool, recipientPk);
  log(`invite target ${recipientPk.slice(0, 12)}…, inbox: ${inbox.join(", ")}`);

  let lastInboxRefresh = Date.now();
  let lastBundleRefresh = Date.now();

  for (;;) {
    const now = Date.now();
    if (now - lastBundleRefresh >= 5 * 60 * 1000) {
      lastBundleRefresh = now;
      try {
        bundle = await resolveBundle(pool, invite);
      } catch (e) {
        log(`bundle refresh failed (keeping last-known): ${e.message}`);
      }
    }
    if (now - lastInboxRefresh >= 30 * 60 * 1000) {
      lastInboxRefresh = now;
      try {
        inbox = await resolveInboxRelays(pool, recipientPk);
      } catch (e) {
        log(`inbox refresh failed (keeping last-known): ${e.message}`);
      }
    }

    const inviterSk = generateSecretKey();
    const inviterPk = getPublicKey(inviterSk);
    // Mostly phantom communities: each is a brand-new community_id, so
    // already-member suppression and decline-tombstones never engage. One in
    // four is the real community so the accept path stays exercised.
    const real = Math.random() < 0.25;
    const b = real ? memberBundle(bundle, inviterPk) : phantomBundle(pick(PHANTOM_NAMES), inviterPk);
    const { wrap, eph } = buildDirectInviteWrap(recipientPk, b, inviterSk);
    ephRing.push(eph);
    if (ephRing.length > 8) ephRing.shift();
    try {
      const res = await pool.publishToAny(inbox, wrap);
      if (res.ok) {
        log(`invite (${real ? "REAL" : "phantom"}) "${b.name}" from ${inviterPk.slice(0, 8)}… -> ${wrap.id.slice(0, 12)}…`);
      } else {
        log(`INVITE REJECTED: ${res.message}`);
      }
    } catch (e) {
      log(`invite error: ${e.message}`);
      await sleep(5000);
    }
    await sleep(opts.intervalMs);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const invite = parseInvite(opts.invite);
  log(`invite parsed: link signer ${invite.linkSigner.slice(0, 12)}…, bootstrap: ${invite.bootstrapRelays.join(", ")}`);

  // Auth signers are looked up lazily so connections always answer challenges
  // with the current identity + current stream keys.
  let identity = newIdentity();
  let bundle = null;
  let channels = [];
  const pool = new RelayPool(() => {
    const signers = [identity.sk];
    if (bundle) {
      // The control READ key's sk — for a LEGACY community this pubkey is also
      // the control stream address, so we can NIP-42 AUTH as it to read control
      // wraps off a relay that gates kind 1059 (ditto: AUTH_KINDS=4,1059).
      // Registered as soon as the bundle resolves, BEFORE discoverChannels
      // queries that author — a lazy signer gated on channels.length would race
      // the very REQ that needs it. (A SPLIT community's control_pk is
      // address-only; we hold no sk for it and can't AUTH as it — by design.)
      signers.push(controlGroupKey(bundle.community_root, bundle.community_id, bundle.root_epoch).sk);
      for (const ch of channels) {
        signers.push(channelGroupKey(bundle.community_root, ch.id, bundle.root_epoch).sk);
      }
    }
    return signers;
  });

  const shutdown = () => {
    log("shutting down");
    pool.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Resolve the invite. CLI one-shot modes fail hard on a bad invite; the
  // 24/7 daemon keeps retrying (a revoked/expired invite heals itself the
  // moment the owner un-revokes or hands over a fresh link).
  const oneShot = opts.resolveOnly || opts.once;
  for (;;) {
    try {
      bundle = await resolveBundle(pool, invite);
      log(`community: "${bundle.name}" id=${bundle.community_id.slice(0, 12)}… epoch=${bundle.root_epoch} relays: ${bundle.relays.join(", ")}`);
      if (opts.inviteSpam) break; // invite delivery needs no channels
      channels = await discoverChannels(pool, bundle);
      log(`public channels: ${channels.map((c) => `#${c.name}`).join(", ") || "(none found)"}`);
      if (channels.length > 0 || oneShot) break;
      log("no public channels found; retrying in 30s");
    } catch (e) {
      if (oneShot) throw e;
      log(`invite resolution failed (${e.message}); retrying in 30s`);
    }
    await sleep(30000);
  }

  if (opts.resolveOnly) {
    pool.closeAll();
    return;
  }

  if (opts.inviteSpam) {
    log(`starting direct-invite spam: one invite every ${opts.intervalMs}ms`);
    await inviteLoop(pool, invite, bundle, opts.inviteSpam, opts);
    return;
  }

  if (channels.length === 0) throw new Error("no public channels to spam");

  if (opts.once) {
    const channel = opts.channel
      ? channels.find((c) => c.name.toLowerCase() === opts.channel.toLowerCase())
      : channels[0];
    if (!channel) throw new Error(`channel #${opts.channel} not found (have: ${channels.map((c) => c.name).join(", ")})`);
    const content = makeContent(opts) ?? generateMessage();
    const skew = opts.futureSkewSecs || 0;
    log(`posting test message to #${channel.name} from ${identity.pk.slice(0, 12)}…${skew ? ` (future-skew +${skew}s)` : ""}`);
    const profRes = await publishProfile(pool, bundle.relays, identity);
    log(`kind-0 profile: ${profRes.ok ? "ok" : `FAILED (${profRes.message})`}`);
    const joinRes = await guestbookJoin(pool, bundle, identity);
    log(`guestbook join: ${joinRes.ok ? "ok" : `FAILED (${joinRes.message})`}`);
    const { wrap, rumor, result } = await postChat(pool, bundle, channel, identity, content, skew);
    if (!result.ok) throw new Error(`publish failed: ${result.message}`);
    log(`accepted: ${wrap.id} (rumor created_at ${rumor.created_at}, ${new Date(rumor.created_at * 1000).toISOString()})`);
    // Read it back end-to-end: fetch the wrap and decrypt both layers.
    const stream = channelGroupKey(bundle.community_root, channel.id, bundle.root_epoch);
    await sleep(1500);
    const backs = await pool.queryAll(
      bundle.relays,
      { kinds: [KIND_WRAP], authors: [stream.pk], since: Math.floor(Date.now() / 1000) - 300 },
    );
    const found = backs.find((w) => w.id === wrap.id);
    if (!found) throw new Error("wrap not found on readback");
    const seal = JSON.parse(nip44Decrypt(found.content, stream.convKey));
    if (seal.kind !== KIND_SEAL_ENCRYPTED || !verifyEvent(seal)) throw new Error("bad seal on readback");
    const back = JSON.parse(nip44Decrypt(seal.content, stream.convKey));
    if (back.id !== rumor.id || back.content !== content || back.pubkey !== identity.pk) {
      throw new Error("rumor mismatch on readback");
    }
    log(`readback verified: rumor ${rumor.id.slice(0, 16)}… decrypts correctly`);
    pool.closeAll();
    return;
  }
  // --- 24/7 chat spam loop: slow pool + gibberish + self-reactions ---
  //
  // Evasion of src/concord/lib/floodCluster.ts AS OF 0cb74b2e:
  //  * Rule 4 (cohort flood) is content-free: it folds crowds of keys chained
  //    arrival-to-arrival (≤10 min gaps) that drown the channel. So keys are
  //    introduced one per 11–14 min — never chained, every key a singleton
  //    cohort, and the rule needs ≥3 chained members to judge anything.
  //  * Rule 1 (density) needs 8 copies of one shape in 5 min: gibberish never
  //    repeats a shape within 10 minutes.
  //  * Rule 2 (echo) needs ≥5 words: gibberish has one token.
  //  * Rule 3 (arrival burst) needs ≥8 messages from ≥6 young keys in 2 min:
  //    intros are 11+ min apart, so at most one key is ever "young".
  //  * Each posted message collects ❤️👍😂 from three other pool keys —
  //    engagement dressing, and reactions are outside every rule's input.
  const POOL_TARGET = 48;
  const keyPool = [];
  let nextIntroAt = 0;
  let rr = 0;

  log(`starting spam (${opts.content}): message every ${opts.intervalMs}ms, slow pool of ${POOL_TARGET} keys (one per 11-14min)`);
  let lastBundleRefresh = Date.now();
  let lastChannelRefresh = Date.now();
  let consecutiveFailures = 0;

  for (;;) {
    const now = Date.now();

    // Epoch freshness: re-resolve the invite so rekeys don't strand us. A
    // revoked invite is logged and tolerated: we keep spamming with the
    // last-known keys until a rekey locks those out.
    if (now - lastBundleRefresh >= 5 * 60 * 1000 || consecutiveFailures >= 5) {
      lastBundleRefresh = now;
      try {
        const fresh = await resolveBundle(pool, invite);
        if (fresh.root_epoch !== bundle.root_epoch) {
          log(`epoch changed ${bundle.root_epoch} -> ${fresh.root_epoch} (rekey detected, following)`);
        }
        bundle = fresh;
        consecutiveFailures = 0;
      } catch (e) {
        log(`bundle refresh failed (keeping last-known keys): ${e.message}`);
      }
    }

    // Channel list freshness (new channels, deletions).
    if (now - lastChannelRefresh >= 15 * 60 * 1000) {
      lastChannelRefresh = now;
      try {
        const fresh = await discoverChannels(pool, bundle);
        if (fresh.length) channels = fresh;
      } catch (e) {
        log(`channel refresh failed: ${e.message}`);
      }
    }

    // Pool growth: one key per 11-14 min (> FLOOD_COHORT_WINDOW_MS), announced
    // with a human kind-0 + a guestbook join like any honest new member.
    if (keyPool.length < POOL_TARGET && now >= nextIntroAt) {
      nextIntroAt = now + 660_000 + Math.floor(Math.random() * 180_000);
      const member = newIdentity();
      keyPool.push(member);
      log(`pool key #${keyPool.length}/${POOL_TARGET}: ${member.pk.slice(0, 12)}…`);
      Promise.all([
        publishProfile(pool, bundle.relays, member),
        guestbookJoin(pool, bundle, member),
      ])
        .then(([p, g]) => {
          if (!p.ok) log(`kind-0 profile failed: ${p.message}`);
          if (!g.ok) log(`guestbook join failed: ${g.message}`);
        })
        .catch(() => {});
    }

    if (keyPool.length === 0) {
      await sleep(1000);
      continue;
    }

    identity = keyPool[rr++ % keyPool.length];
    const channel = pick(channels);
    const content = makeContent(opts);
    if (!content) {
      await sleep(opts.intervalMs);
      continue;
    }
    try {
      const { wrap, rumor, result } = await postChat(pool, bundle, channel, identity, content);
      if (result.ok) {
        consecutiveFailures = 0;
        log(`[${identity.pk.slice(0, 8)}] #${channel.name}: ${JSON.stringify(content.slice(0, 72))} -> ${wrap.id.slice(0, 12)}…`);
        // Engagement dressing: ❤️ 👍 😂 from three other pool keys, best-effort.
        const others = keyPool.filter((m) => m.pk !== identity.pk);
        for (let k = 0; k < Math.min(3, others.length); k++) {
          const reactor = others[(rr + k) % others.length];
          postReaction(pool, bundle, channel, reactor, rumor.id, identity.pk, ["❤️", "👍", "😂"][k])
            .then((r) => !r.ok && log(`reaction failed: ${r.message}`))
            .catch(() => {});
        }
      } else {
        consecutiveFailures++;
        log(`PUBLISH REJECTED (${consecutiveFailures}): ${result.message}`);
      }
    } catch (e) {
      consecutiveFailures++;
      log(`publish error (${consecutiveFailures}): ${e.message}`);
      await sleep(Math.min(5000 * consecutiveFailures, 30000));
    }

    await sleep(opts.intervalMs);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(`fatal: ${e.message}`);
    process.exit(1);
  });
}

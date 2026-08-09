#!/usr/bin/env node
/**
 * Concord spam bot — moderation-UX test harness.
 *
 * Joins a Concord community from an invite link and posts a continuous stream
 * of realistic-looking (but harmless) spam to its public channels, using a
 * brand-new Nostr identity for EVERY message. The intent is to simulate a
 * persistent, ban-evading spammer so the client's moderation UX (mutes, bans,
 * rekeys, member list churn) can be exercised against something that behaves
 * like the real thing.
 *
 * Each message's identity announces itself with a kind-0 profile carrying a
 * stable instance id and a sequence number (`spambot <instance> #<n>`), the
 * previous identity's npub in `about` (forming a chain across messages), and
 * the NIP-24 `bot` flag — so the client can track the bot across key changes.
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
 *   --interval-ms <n>   Delay between messages (default 3000)
 *   --resolve-only      Resolve the invite, print community + channels, exit
 *   --once              Post a single message, verify it reads back, exit
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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

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
  const pre = new Uint8Array([
    ...te.encode("concord/community"),
    ...hexToBytes(ownerHex),
    ...hexToBytes(saltHex),
  ]);
  return bytesToHex(sha256(pre)) === idHex.toLowerCase();
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
    this.getAuthSigners = getAuthSigners;
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
  // The control plane has split read/write keys: the read key is derived from
  // the community root, while wraps are authored by the owner's control_pk.
  const readKey = controlGroupKey(bundle.community_root, bundle.community_id, bundle.root_epoch);
  const wraps = await pool.queryAll(
    bundle.relays,
    { kinds: [KIND_WRAP], authors: [bundle.control_pk] },
    20000,
  );
  const editions = new Map(); // eid -> {ev, vsk, content}
  for (const wrap of wraps) {
    if (wrap.pubkey !== bundle.control_pk || !verifyEvent(wrap)) continue;
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
  for (const [eid, ed] of editions) {
    if (ed.vsk !== "2") continue;
    try {
      const def = JSON.parse(ed.content);
      if (def.deleted || def.private) continue;
      channels.push({ id: eid, name: def.name ?? "channel" });
    } catch {
      // skip
    }
  }
  return channels;
}

// ---------------------------------------------------------------------------
// Spam content: realistic shape, harmless destinations (RFC 2606 domains)
// ---------------------------------------------------------------------------

const TOKENS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "PEPE", "SHIB", "ADA", "AVAX", "LINK"];
const URLS = [
  "https://doubler.example.com",
  "https://claim-airdrop.example.com",
  "https://verify-wallet.example.com",
  "https://signals-pro.example.com",
  "https://freemint.example.com",
  "https://bonus-pool.example.com",
  "https://prize-draw.example.com",
  "https://elon-giveaway.example.com",
  "https://pump-alerts.example.com",
  "https://wallet-sync.example.com",
];
const NAMES = ["Jessica", "Mike", "CryptoKing", "Sarah", "TraderJoe", "Luna", "AdminSupport", "Dave"];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const amount = () => (Math.floor(Math.random() * 500) + 10) * 10;
const pct = () => Math.floor(Math.random() * 900) + 100;

function spamContent() {
  const t = pick(TOKENS);
  const url = pick(URLS);
  const templates = [
    () => `URGENT: ${t} doubling event live now! Send any amount to the event address and get 2x back instantly. Over ${amount()} ${t} already distributed. ${url}`,
    () => `Congratulations! Your wallet was selected in the ${t} airdrop snapshot. Claim ${amount()} ${t} before the pool closes: ${url}`,
    () => `I made ${pct()}% in 2 weeks with this signals group. Join free today, spots limited: ${url}`,
    () => `[ALERT] Suspicious login detected on your account. Verify your wallet immediately or funds will be frozen: ${url}`,
    () => `FREE MINT is LIVE! Only ${Math.floor(Math.random() * 900) + 100} spots left. Mint yours now: ${url}`,
    () => `Hi, I'm ${pick(NAMES)} from official support. We detected unusual activity on your account. Please confirm your recovery phrase here to avoid suspension: ${url}`,
    () => `${t} is about to PUMP. Insider news dropping in 1 hour, get in early: ${url}`,
    () => `Earn $${amount()} per day from home with this one simple trick. No experience needed: ${url}`,
    () => `Flash giveaway! First 100 people to register get ${amount()} ${t} absolutely free: ${url}`,
    () => `Why is nobody talking about this? ${t} staking at ${pct()}% APY, I've already withdrawn twice: ${url}`,
    () => `This community is dead, everyone moved to the real server. Join us: ${url}`,
    () => `Mods are banning everyone who knows the truth. Screenshot this before it gets deleted: ${url}`,
    () => `hey, check your DMs, I sent you something`,
    () => `Anyone else unable to withdraw? Support told me to use this official sync portal and it worked: ${url}`,
    () => `You have been selected for the ${t} community rewards program. Register within 24h: ${url}`,
  ];
  return pick(templates)();
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { intervalMs: 3000, once: false, resolveOnly: false, invite: undefined };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    switch (a) {
      case "--interval-ms":
        opts.intervalMs = Number(args.shift());
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

function newIdentity(prevPk) {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), index: ++identityCounter, prevPk };
}

/**
 * Stable-per-install bot id, persisted next to the invite file so identities
 * stay attributable to this bot across service restarts.
 */
function loadInstanceId() {
  const path = join(homedir(), ".config", "armada-spambot", "instance-id");
  try {
    const id = readFileSync(path, "utf8").trim();
    if (id) return id;
  } catch {
    /* first run */
  }
  const id = bytesToHex(generateSecretKey().slice(0, 4));
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, id + "\n", { mode: 0o600 });
  } catch {
    /* non-fatal: fall through with the ephemeral id */
  }
  return id;
}

/**
 * Announce the current identity with a kind-0 profile so rotations can be
 * tracked: stable instance id + rotation index in `name`, previous identity's
 * npub in `about` (chain), NIP-24 `bot` flag.
 */
async function publishProfile(pool, bundle, identity, instanceId) {
  const profile = {
    name: `spambot ${instanceId} #${identity.index}`,
    about:
      `Automated moderation-test spam bot (armada scripts/spambot.mjs), ` +
      `instance ${instanceId}, identity #${identity.index}.` +
      (identity.prevPk ? ` Previous identity: ${nip19.npubEncode(identity.prevPk)}` : ""),
    bot: true,
  };
  const event = finalizeEvent(
    {
      kind: KIND_PROFILE,
      content: JSON.stringify(profile),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    identity.sk,
  );
  return pool.publishToAny(bundle.relays, event);
}

async function postChat(pool, bundle, channel, identity, content) {
  const stream = channelGroupKey(bundle.community_root, channel.id, bundle.root_epoch);
  const rumor = buildRumor({
    kind: KIND_CHAT,
    content,
    tags: [
      ["channel", channel.id],
      ["epoch", String(bundle.root_epoch)],
    ],
    pubkey: identity.pk,
    ms: Date.now(),
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (bundle && channels.length) {
      for (const ch of channels) {
        signers.push(channelGroupKey(bundle.community_root, ch.id, bundle.root_epoch).sk);
      }
      signers.push(controlGroupKey(bundle.community_root, bundle.community_id, bundle.root_epoch).sk);
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
  if (channels.length === 0) throw new Error("no public channels to spam");

  if (opts.once) {
    const channel = channels[0];
    const content = spamContent();
    log(`posting test message to #${channel.name} from ${identity.pk.slice(0, 12)}…`);
    const profRes = await publishProfile(pool, bundle, identity, loadInstanceId());
    log(`kind-0 profile: ${profRes.ok ? "ok" : `FAILED (${profRes.message})`}`);
    const joinRes = await guestbookJoin(pool, bundle, identity);
    log(`guestbook join: ${joinRes.ok ? "ok" : `FAILED (${joinRes.message})`}`);
    const { wrap, rumor, result } = await postChat(pool, bundle, channel, identity, content);
    if (!result.ok) throw new Error(`publish failed: ${result.message}`);
    log(`accepted: ${wrap.id}`);
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

  // --- 24/7 spam loop: a brand-new identity for every single message ---
  log(`starting spam: message every ${opts.intervalMs}ms, fresh key per message`);
  const instanceId = loadInstanceId();

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

    // Fresh key per message: banning any one identity buys exactly one
    // message of silence. The kind-0 + guestbook join announce the key so
    // profile/member-list UX sees the churn.
    identity = newIdentity(identity.pk);
    const channel = pick(channels);
    const content = spamContent();
    try {
      const [profRes, joinRes] = await Promise.all([
        publishProfile(pool, bundle, identity, instanceId),
        guestbookJoin(pool, bundle, identity),
      ]);
      if (!profRes.ok) log(`kind-0 profile failed: ${profRes.message}`);
      if (!joinRes.ok) log(`guestbook join failed: ${joinRes.message}`);
      const { wrap, result } = await postChat(pool, bundle, channel, identity, content);
      if (result.ok) {
        consecutiveFailures = 0;
        log(`[${identity.pk.slice(0, 8)}] (#${identity.index}) #${channel.name}: ${JSON.stringify(content.slice(0, 72))} -> ${wrap.id.slice(0, 12)}…`);
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

main().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});

/**
 * Concord voice — CORD-07.
 *
 * Every Channel is callable — a call is simply started in it. Two
 * sub-keys derive from the Channel's secret (CORD-07 §1, see derive.ts):
 * `voice_key` (its pk is the SFU room name, its sk signs token grants) and
 * `voice_media_key` (the root of per-sender media encryption). Anyone holding
 * the Channel's key can fetch a short-lived token from a **blind broker** and
 * connect to the SFU; media is end-to-end encrypted under keys only members
 * can derive, so the broker and SFU only ever forward ciphertext.
 *
 * Who is in a call is announced over the Channel itself (§4): ephemeral
 * kind-23313 rumors in 21059 wraps at the Channel's own address, sealed
 * encrypted like everything else on the Chat Plane, so relays and brokers stay
 * blind. The `broker` tag on live presence is the rendezvous hint (§5).
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { finalizeEvent } from "nostr-tools/pure";

import { bytesToHex, hexToBytes, random32, type GroupKey } from "@/concord/lib/derive";
import { KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";
import type { OpenedEvent } from "@/concord/lib/stream";

// ── Protocol constants (CORD-07) ─────────────────────────────────────────────

/** NIP-98-style HTTP-auth event kind — the token grant's carrier (§2). */
export const KIND_HTTP_AUTH = 27235;
/** Publish a `joined` on join and every 30 seconds thereafter (§4). */
export const VOICE_HEARTBEAT_MS = 30_000;
/** A `joined` older than 90s (three missed heartbeats) counts as absent (§4). */
export const VOICE_STALE_MS = 90_000;

/**
 * The delay until the next heartbeat: 80–100% of §4's 30s.
 *
 * Jittered so members who joined together — everyone in a channel after a rekey
 * remounts the room — don't stay phase-locked and beat the relays in
 * synchronized bursts. Jittered DOWNWARD only, and that direction is the whole
 * point: at or under 30s, three missed heartbeats still fit inside the 90s
 * staleness window, so the margin only widens. Jittering above 30s would shrink
 * it to two missed heartbeats and make members flicker out of rosters.
 */
export function heartbeatDelayMs(random: () => number = Math.random): number {
  return VOICE_HEARTBEAT_MS * (0.8 + random() * 0.2);
}
/** Bound the broker candidates taken from (untrusted) presence hints (§5). */
export const MAX_VOICE_BROKERS = 3;

const ASCII = new TextEncoder();

// ── Origins (§5) ─────────────────────────────────────────────────────────────

/**
 * The RFC 6454 ASCII serialization of an https origin: lowercase scheme and
 * host, default port omitted, no path and no trailing slash — one canonical
 * byte-form, or two clients hash different strings for one broker and the §5
 * tie-break never settles. Returns null for anything that isn't a clean https
 * origin (brokers are bearer-credential endpoints; plaintext http is refused).
 */
export function canonicalOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  const port = url.port && url.port !== "443" ? `:${url.port}` : "";
  return `https://${host}${port}`;
}

/**
 * The §5 tie-break rank of a broker origin for a room:
 * `sha256(voice_room[32] || utf8(origin))`, compared bytewise (as hex) —
 * smallest wins. Grindable by design; that buys an attacker nothing more than
 * the (already untrusted) hint grants.
 */
export function brokerRank(roomHex: string, origin: string): string {
  const originBytes = ASCII.encode(origin);
  const pre = new Uint8Array(32 + originBytes.length);
  pre.set(hexToBytes(roomHex), 0);
  pre.set(originBytes, 32);
  return bytesToHex(sha256(pre));
}

/** Order candidate origins by the §5 tie-break (canonicalized, deduped). */
export function orderBrokers(roomHex: string, origins: string[]): string[] {
  const canonical = [...new Set(origins.map(canonicalOrigin).filter((o): o is string => Boolean(o)))];
  return canonical.sort((a, b) => (brokerRank(roomHex, a) < brokerRank(roomHex, b) ? -1 : 1));
}

// ── The broker (§2) ──────────────────────────────────────────────────────────

/** The broker's capability probe: `GET <origin>/.well-known/concord/av` → 204. */
export function avCapabilityUrl(origin: string): string {
  return `${origin}/.well-known/concord/av`;
}

/** The broker's token endpoint for a room. */
export function avTokenUrl(origin: string, roomHex: string): string {
  return `${origin}/.well-known/concord/av/${roomHex}`;
}

/** A minted SFU token: the JWT, the SFU ws url, and the assigned identity. */
export interface AvToken {
  token: string;
  url: string;
  /** The broker-assigned random SFU identity — announced in presence (§4). */
  identity: string;
  /**
   * The broker origin that actually minted this token. Not always the one the
   * rendezvous picked: when that broker is unreachable we fall through to the
   * next candidate, and it is THIS origin that must ride presence as the §5
   * hint — announcing the one we failed to reach would send everyone else to a
   * broker that is not hosting the call.
   */
  origin: string;
}

/**
 * Sign the token grant (§2): a kind-27235 event self-signed with
 * `voice_key.sk`, so `event.pubkey` equals the room name. The grant lives only
 * in the Authorization header; it never touches a relay.
 *
 * The `nonce` tag carries 32 fresh random bytes and is REQUIRED (§2). Every
 * member of a Channel derives and signs with the SAME `voice_key.sk`, so
 * without it two members joining one room in the same second build
 * byte-identical events — same id — and the broker's anti-replay set (which
 * keys on the id) rejects whichever arrives second. NIP-98, whose shape this
 * borrows, never needs one: each request there is signed by its own user's key.
 */
export function signAvGrant(voice: GroupKey, url: string): string {
  const event = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      content: "",
      tags: [
        ["u", url],
        ["method", "GET"],
        ["nonce", bytesToHex(random32())],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    voice.sk,
  );
  return btoa(JSON.stringify(event));
}

/**
 * Probe a broker's capability endpoint. Strictly 204 — the endpoint's
 * documented answer — never a general `res.ok`: an SPA origin answers every
 * unknown path 200 with its HTML shell, which is precisely the misconfigured
 * candidate this probe exists to skip.
 */
export async function probeAvBroker(origin: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(avCapabilityUrl(origin), {
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/**
 * Fetch an SFU token from a blind broker (§2). Validates the response shape
 * and requires the SFU url be `wss://` — the broker is untrusted rendezvous
 * input, and E2EE bounds a hostile one to metadata, but there's no reason to
 * accept a plaintext signaling downgrade.
 */
export async function fetchAvToken(origin: string, voice: GroupKey): Promise<AvToken> {
  const url = avTokenUrl(origin, voice.pk);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Concord ${signAvGrant(voice, url)}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Voice token request failed: HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  const token = typeof data.token === "string" ? data.token : "";
  const sfuUrl = typeof data.url === "string" ? data.url : "";
  const identity = typeof data.identity === "string" ? data.identity : "";
  if (!token || !sfuUrl || !identity) throw new Error("Voice token response missing token, url, or identity");
  if (!/^wss:\/\//i.test(sfuUrl)) throw new Error("Broker returned a non-wss SFU url");
  return { token, url: sfuUrl, identity, origin };
}

/**
 * Mint from the first candidate that answers, in §5 rendezvous order.
 *
 * The capability probe (§5) only says a broker was reachable a moment ago; it
 * can still fail to mint — restarting, at capacity, or its SFU gone. Without a
 * fall-through that is a dead end for the caller, since a client resolves one
 * broker per join and has nothing to retry against. It is also what lets a
 * broker shed load honestly at the token endpoint: refusing a room it does not
 * host now moves the caller on instead of stranding them.
 *
 * Rejections are not sorted by kind — a grant this room's key cannot satisfy
 * fails everywhere, so trying the rest costs a few requests once, while
 * treating a 503 as fatal would cost the call.
 */
export async function fetchAvTokenFromAny(origins: string[], voice: GroupKey): Promise<AvToken> {
  const candidates = [...new Set(origins.filter(Boolean))];
  if (candidates.length === 0) throw new Error("No voice server to request a token from");
  let lastError: unknown;
  for (const origin of candidates) {
    try {
      return await fetchAvToken(origin, voice);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No reachable voice server");
}

// ── Presence (§4) ────────────────────────────────────────────────────────────

/** One member's latest presence, as opened from the Channel's stream. */
export interface VoicePresenceEntry {
  author: string;
  status: "joined" | "left";
  /** The broker-assigned SFU identity (joined only). */
  identity?: string;
  /** The broker origin hint, canonicalized (joined only). */
  broker?: string;
  /**
   * Whether this member has their hand raised (joined only) — an ARMADA CLIENT
   * EXTENSION, not part of CORD-07. It rides as an additive `["hand","1"]` tag
   * on the presence rumor; per CORD-02 §6 (additive change / unknown-field
   * round-tripping) an old client simply ignores it, so no frozen kind is spent
   * and brokers/relays stay blind (it's sealed like all presence). Sticky state:
   * carried on every heartbeat and healed by the same staleness window.
   */
  hand?: boolean;
  /** Millisecond ordering basis (CORD-02 §4). */
  ms: number;
  /** The rumor id — the equal-ms tiebreak. */
  rumorId: string;
}

/**
 * The presence tags a `joined` carries beyond the channel/epoch binding. `hand`
 * is an Armada client extension (see {@link VoicePresenceEntry.hand}); it's
 * emitted only while joined and only when raised (its absence means lowered).
 */
export function presenceTags(
  status: "joined" | "left",
  identity?: string,
  broker?: string,
  opts?: { hand?: boolean },
): string[][] {
  const tags: string[][] = [];
  if (status === "joined" && identity) tags.push(["identity", identity]);
  if (status === "joined" && broker) tags.push(["broker", broker]);
  if (status === "joined" && opts?.hand) tags.push(["hand", "1"]);
  return tags;
}

/**
 * The max byte length of a reaction's emoji payload. Bounds a hostile member's
 * ability to bloat the transient reaction list; comfortably fits any single
 * emoji (incl. ZWJ sequences) or a short custom shortcode.
 */
const MAX_REACTION_LEN = 64;

/** A transient in-call emoji reaction, as opened from the Channel's stream. */
export interface VoiceReactionEntry {
  /** The verified real author (the presence rumor's seal signer). */
  author: string;
  /** The emoji (or shortcode) to float. */
  emoji: string;
  /** The sender-chosen nonce — the fire-once/dedup key. */
  nonce: string;
  /** Millisecond stamp (CORD-02 §4) — the decay basis. */
  ms: number;
}

/**
 * The reaction tag an in-call emoji rides — an ARMADA CLIENT EXTENSION, not
 * part of CORD-07. A reaction is a transient, fire-and-forget event, so it
 * rides as an additive `["react", emoji, nonce]` tag on an off-cycle `joined`
 * presence rumor (which doubles as a heartbeat). Receivers fire the emoji once
 * per unseen nonce and never fold it into state. Spec-legal via CORD-02 §6
 * (additive tag on an existing kind); an old client ignores it.
 */
export function reactionTag(emoji: string, nonce: string): string[] {
  return ["react", emoji, nonce];
}

/**
 * Parse an opened kind-23313 rumor's reaction tag into a reaction entry, or
 * null when it carries none (a plain presence heartbeat) or a malformed one.
 * The channel/epoch binding is checked by the caller, like every Chat rumor.
 */
export function parseReaction(opened: OpenedEvent): VoiceReactionEntry | null {
  if (opened.kind !== KIND_VOICE_PRESENCE) return null;
  const tag = opened.tags.find((t) => t[0] === "react");
  if (!tag) return null;
  const emoji = tag[1];
  const nonce = tag[2];
  if (typeof emoji !== "string" || emoji.length === 0) return null;
  // Bound the payload (untrusted member input) — reject rather than truncate,
  // so two clients never disagree on what floated.
  if (new TextEncoder().encode(emoji).length > MAX_REACTION_LEN) return null;
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) return null;
  return { author: opened.author, emoji, nonce, ms: opened.ms };
}

/**
 * Parse an opened kind-23313 rumor into a presence entry. The channel/epoch
 * binding is checked by the caller (like every Chat rumor); this validates the
 * presence shape. Returns null for malformed entries.
 */
export function parsePresence(opened: OpenedEvent): VoicePresenceEntry | null {
  if (opened.kind !== KIND_VOICE_PRESENCE) return null;
  if (opened.content !== "joined" && opened.content !== "left") return null;
  const status = opened.content;
  const rawIdentity = opened.tags.find((t) => t[0] === "identity")?.[1];
  const rawBroker = opened.tags.find((t) => t[0] === "broker")?.[1];
  // Identities are broker-assigned opaque strings; bound them so a hostile
  // member can't bloat presence state.
  const identity =
    status === "joined" && typeof rawIdentity === "string" && rawIdentity.length > 0 && rawIdentity.length <= 128
      ? rawIdentity
      : undefined;
  if (status === "joined" && !identity) return null;
  const broker =
    status === "joined" && typeof rawBroker === "string" && rawBroker.length <= 512
      ? canonicalOrigin(rawBroker) ?? undefined
      : undefined;
  const hand = status === "joined" && opened.tags.some((t) => t[0] === "hand" && t[1] === "1");
  return { author: opened.author, status, identity, broker, hand, ms: opened.ms, rumorId: opened.rumorId };
}

/** A verified-present participant: one fresh `joined` per author. */
export interface VoicePresent {
  author: string;
  identity: string;
  broker?: string;
  /** Whether this member's latest presence has their hand raised (client ext). */
  hand: boolean;
  ms: number;
}

/** The folded presence view of one channel's call. */
export interface VoicePresenceFold {
  /** Fresh `joined` authors (per author, the latest presence won). */
  present: VoicePresent[];
  /**
   * SFU identity → the authors whose fresh presence claims it. A participant
   * renders as a member only when exactly ONE author claims its identity (§4);
   * contested or unclaimed identities render as unverified.
   */
  claims: Map<string, string[]>;
}

/**
 * Fold raw presence entries: per author the latest wins (ms basis, rumor-id
 * tiebreak), then a `joined` older than the staleness window counts as absent.
 */
export function foldVoicePresence(entries: VoicePresenceEntry[], nowMs: number): VoicePresenceFold {
  const latest = new Map<string, VoicePresenceEntry>();
  for (const e of entries) {
    const prev = latest.get(e.author);
    if (!prev || e.ms > prev.ms || (e.ms === prev.ms && e.rumorId < prev.rumorId)) {
      latest.set(e.author, e);
    }
  }
  const present: VoicePresent[] = [];
  const claims = new Map<string, string[]>();
  for (const e of latest.values()) {
    if (e.status !== "joined" || !e.identity) continue;
    if (nowMs - e.ms > VOICE_STALE_MS) continue;
    present.push({ author: e.author, identity: e.identity, broker: e.broker, hand: e.hand ?? false, ms: e.ms });
    const list = claims.get(e.identity);
    if (list) list.push(e.author);
    else claims.set(e.identity, [e.author]);
  }
  present.sort((a, b) => a.ms - b.ms || (a.author < b.author ? -1 : 1));
  return { present, claims };
}

/**
 * The author verifiably behind an SFU identity, or undefined when the identity
 * is unclaimed or contested (all claimants of one identity prove nothing about
 * either author — they render as unverified until the stale claims age out).
 */
export function verifiedAuthorOf(fold: VoicePresenceFold, identity: string): string | undefined {
  const claimants = fold.claims.get(identity);
  return claimants && claimants.length === 1 ? claimants[0] : undefined;
}

/**
 * The §5 rendezvous decision: if anyone is present, their brokers (ordered by
 * the tie-break) are the candidates; an empty room falls back to the client's
 * own defaults, in their stated order. The presence hints are untrusted input
 * from fellow members, so they're canonicalized and capped.
 */
export function rendezvousCandidates(roomHex: string, fold: VoicePresenceFold, defaults: string[]): string[] {
  const occupied = orderBrokers(
    roomHex,
    fold.present.map((p) => p.broker).filter((b): b is string => Boolean(b)),
  ).slice(0, MAX_VOICE_BROKERS);
  const own = defaults.map(canonicalOrigin).filter((o): o is string => Boolean(o));
  // Occupied origins first (join the call where it is), own defaults as the
  // fallback when they're empty or unreachable.
  return [...new Set([...occupied, ...own])];
}

/**
 * Public (link) invites — ported from Vector's `community/public_invite.rs`.
 *
 * A public invite is a shareable URL whose `#fragment` carries a fetch-token,
 * never the keys. From the token, three sub-keys derive (`derive`): a NIP-44
 * decryption key for the bundle, a locator (addressable `d`-tag), and a stable
 * signer key (so re-posting rotates the link and a joiner rejects an impostor
 * squatting the locator). The bundle carries the join material plus a preview.
 *
 * The URL fragment is the v2 binary format `[ver][flags][relays?][token:32]`,
 * base64url. armada uses an explicit-literal relay scheme (no default-set flag,
 * since armada's relay set is deployment-specific) plus the dictionary path for
 * compactness; the legacy v1 JSON fragment still parses.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import { open as cipherOpen, seal as cipherSeal } from "@/lib/concord/cipher";
import { publicInviteKey, publicInviteLocator, publicInviteSigner } from "@/lib/concord/derive";
import { buildInvite, type CommunityInvite } from "@/lib/concord/invite";
import { KIND_APPLICATION_SPECIFIC } from "@/lib/concord/kinds";
import { random32, type Community } from "@/lib/concord/types";

/** Path the invite link lands on (consumed client-side; the fragment never hits the relay). */
export const INVITE_URL_PATH = "/invite";

/**
 * The shareable invite link's base (`<origin>/invite`). Derives from the actual
 * deployment origin so the link resolves to *this* app (a fixed placeholder host
 * like `armada.invite` does not exist and 404s). Falls back to a bare path when
 * there's no `window` (SSR/tests).
 */
export function inviteUrlBase(): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${INVITE_URL_PATH}`;
}
const MAX_URL_RELAYS = 32;
const TAG_VERSION = "v";
const TAG_SUBKIND = "vsk";
const PROTOCOL_VERSION = "1";
const VSK_PUBLIC_INVITE = "6";
const VSK_PUBLIC_INVITE_REVOKED = "9";

const URL_V2 = 2;
const MAX_V2_BOOTSTRAP_RELAYS = 3;

/**
 * v2 flags bit: the invite's bundle lives on the stock {@link TRUSTED_RELAYS}
 * set, so the link carries no relay bytes at all. Set on Vector's
 * default-relay-set links (the common case). FROZEN — part of the shared
 * Vector wire format.
 */
const V2_FLAG_DEFAULT_RELAYS = 0b0000_0001;

/**
 * Vector's stock relay set, resolved when a v2 link sets
 * {@link V2_FLAG_DEFAULT_RELAYS}. Mirrors `vector-core`'s `TRUSTED_RELAYS`
 * verbatim: a default-set Vector invite carries no relays, so cross-compat
 * REQUIRES we know exactly where its bundle is posted. FROZEN — keep in lockstep
 * with Vector; changing it silently breaks every default-set link.
 */
export const TRUSTED_RELAYS: readonly string[] = [
  "wss://jskitty.com/nostr",
  "wss://asia.vectorapp.io/nostr",
  "wss://nostr.computingcache.com",
];

/**
 * Append-only dictionary of well-known relays for v2 links — a listed relay
 * costs ONE byte (its 1-based id) instead of a length-prefixed literal. Ids live
 * in 1..=254 (0 = wss-implied literal, 255 = verbatim literal). NEVER renumber
 * or remove entries (ids are baked into minted links forever); append only, in
 * lockstep with Vector's copy.
 */
const RELAY_DICTIONARY: readonly string[] = [
  "wss://jskitty.com/nostr",        // id 1
  "wss://asia.vectorapp.io/nostr",  // id 2
  "wss://nostr.computingcache.com", // id 3
  "wss://relay.damus.io",           // id 4
];

/** Order/case/trailing-slash-insensitive relay comparison key (matches Vector's `norm_relay`). */
function normRelay(r: string): string {
  return r.trim().replace(/\/+$/, "").toLowerCase();
}

/** True when `relays` is exactly the stock trusted set (set-equal, normalized). */
function isDefaultRelaySet(relays: string[]): boolean {
  const want = new Set(TRUSTED_RELAYS.map(normRelay));
  const have = new Set(relays.map(normRelay));
  if (want.size !== have.size) return false;
  for (const r of want) if (!have.has(r)) return false;
  return true;
}

/** The 1-based dictionary id for a relay, or `undefined` if it isn't a known relay. */
function dictionaryId(relay: string): number | undefined {
  const n = normRelay(relay);
  const i = RELAY_DICTIONARY.findIndex((d) => normRelay(d) === n);
  return i >= 0 ? i + 1 : undefined;
}

export interface PublicInvitePreview {
  name: string;
  description?: string;
}

export interface PublicInviteBundle {
  preview: PublicInvitePreview;
  join: CommunityInvite;
  expires_at?: number;
  creator_npub?: string;
  label?: string;
}

export function isExpired(bundle: PublicInviteBundle, nowSecs: number): boolean {
  return bundle.expires_at !== undefined && nowSecs >= bundle.expires_at;
}

export class PublicInviteError extends Error {
  constructor(
    public code:
      | "json"
      | "cipher"
      | "sign"
      | "unexpected-signer"
      | "bad-signature"
      | "wrong-version"
      | "wrong-subkind"
      | "bad-url"
      | "expired"
      | "revoked",
    message: string,
  ) {
    super(message);
    this.name = "PublicInviteError";
  }
}

/** Mint a fresh 32-byte token (the whole secret of a public invite). */
export function newToken(): Uint8Array {
  return random32();
}

function previewOf(community: Community): PublicInvitePreview {
  return { name: community.name, description: community.description };
}

/** The addressable `d`-tag (hex locator) a public invite for `token` is posted under. */
export function locatorHex(token: Uint8Array): string {
  return bytesToHex(publicInviteLocator(token));
}

/** The public key (hex) a valid bundle for `token` must be signed by. */
export function signerPubkey(token: Uint8Array): string {
  return getPublicKey(publicInviteSigner(token));
}

/** Build the signed, token-encrypted bundle event (kind 30078, addressable at the locator). */
export function buildPublicInviteEvent(
  community: Community,
  token: Uint8Array,
  opts: { expiresAt?: number; creatorNpub?: string; label?: string } = {},
): NostrEvent {
  const bundle: PublicInviteBundle = {
    preview: previewOf(community),
    join: buildInvite(community),
    expires_at: opts.expiresAt,
    creator_npub: opts.creatorNpub,
    label: opts.label,
  };
  const content = cipherSeal(publicInviteKey(token), JSON.stringify(bundle));
  const signerSk = publicInviteSigner(token);
  return finalizeEvent(
    {
      kind: KIND_APPLICATION_SPECIFIC,
      content,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", locatorHex(token)],
        [TAG_SUBKIND, VSK_PUBLIC_INVITE],
        [TAG_VERSION, PROTOCOL_VERSION],
      ],
    },
    signerSk,
  );
}

/** Build a token-signed revocation tombstone at the bundle's coordinate. */
export function buildPublicInviteTombstone(token: Uint8Array): NostrEvent {
  const signerSk = publicInviteSigner(token);
  return finalizeEvent(
    {
      kind: KIND_APPLICATION_SPECIFIC,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", locatorHex(token)],
        [TAG_SUBKIND, VSK_PUBLIC_INVITE_REVOKED],
        [TAG_VERSION, PROTOCOL_VERSION],
      ],
    },
    signerSk,
  );
}

function findTag(ev: NostrEvent, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1];
}

/**
 * Verify + decrypt a bundle event with the URL token. Checks version, that the
 * author is the token-derived signer (rejects an impostor), the signature, the
 * sub-kind, then decrypts. Does NOT enforce expiry (callers gate joins on
 * {@link isExpired}). Throws PublicInviteError.
 */
export function parsePublicInviteEvent(event: NostrEvent, token: Uint8Array): PublicInviteBundle {
  const version = findTag(event, TAG_VERSION);
  if (version !== PROTOCOL_VERSION) {
    throw new PublicInviteError("wrong-version", `unsupported invite version: ${version}`);
  }
  if (event.pubkey !== signerPubkey(token)) {
    throw new PublicInviteError("unexpected-signer", "bundle not signed by the invite token");
  }
  if (!verifyEvent(event)) throw new PublicInviteError("bad-signature", "bundle signature invalid");
  const subkind = findTag(event, TAG_SUBKIND);
  if (subkind === VSK_PUBLIC_INVITE_REVOKED) {
    throw new PublicInviteError("revoked", "this invite was revoked");
  }
  if (subkind !== VSK_PUBLIC_INVITE) {
    throw new PublicInviteError("wrong-subkind", `not a public-invite bundle: ${subkind}`);
  }
  let plaintext: string;
  try {
    plaintext = cipherOpen(publicInviteKey(token), event.content);
  } catch (e) {
    throw new PublicInviteError("cipher", `cipher: ${e instanceof Error ? e.message : e}`);
  }
  try {
    return JSON.parse(plaintext) as PublicInviteBundle;
  } catch (e) {
    throw new PublicInviteError("json", `json: ${e instanceof Error ? e.message : e}`);
  }
}

// --- URL encoding (the #fragment carries everything) ---

function base64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Build the shareable invite URL (v2 binary fragment): `[ver][flags][relays?][token:32]`,
 * base64url. Faithful port of Vector's `encode_invite_url` for cross-compat:
 *   - the stock relay set costs ZERO relay bytes (the {@link V2_FLAG_DEFAULT_RELAYS} flag);
 *   - a well-known relay costs ONE byte (its {@link RELAY_DICTIONARY} id);
 *   - a custom relay is a length-prefixed literal (`wss://` implied as id 0, else verbatim id 255).
 */
export function encodeInviteUrl(relays: string[], token: Uint8Array): string {
  const payload: number[] = [URL_V2];
  if (isDefaultRelaySet(relays)) {
    payload.push(V2_FLAG_DEFAULT_RELAYS);
  } else {
    payload.push(0);
    // Bootstrap only — the bundle carries the authoritative set. Relays whose
    // host exceeds 255 bytes can't be length-prefixed; skip them (absurd in practice).
    const boot = relays
      .filter((r) => (r.startsWith("wss://") ? r.slice(6) : r).length <= 255)
      .slice(0, MAX_V2_BOOTSTRAP_RELAYS);
    payload.push(boot.length);
    for (const r of boot) {
      const id = dictionaryId(r);
      if (id !== undefined) {
        payload.push(id);
        continue;
      }
      // Literal: `wss://` rides implied as entry 0; anything else is stored
      // VERBATIM as entry 255 so the string round-trips exactly.
      const host = r.startsWith("wss://") ? r.slice(6) : null;
      const kind = host !== null ? 0 : 255;
      const s = host ?? r;
      payload.push(kind, s.length);
      for (let i = 0; i < s.length; i++) payload.push(s.charCodeAt(i) & 0xff);
    }
  }
  for (const b of token) payload.push(b);
  return `${inviteUrlBase()}#${base64urlEncode(new Uint8Array(payload))}`;
}

/**
 * Parse a shareable invite URL (or a bare fragment) back to `{ relays, token }`.
 * Accepts the full URL or just the fragment after `#`, in either the v2 binary
 * format or the legacy v1 JSON format (v1 links in the wild stay valid forever).
 * A v1 fragment is base64url(JSON) whose first decoded byte is `{` (0x7B); a v2
 * fragment's first byte is the version (2). The two never collide.
 */
export function parseInviteUrl(url: string): { relays: string[]; token: Uint8Array } {
  const idx = url.lastIndexOf("#");
  const fragment = idx >= 0 ? url.slice(idx + 1) : url;
  if (!fragment) throw new PublicInviteError("bad-url", "no fragment");
  let raw: Uint8Array;
  try {
    raw = base64urlDecode(fragment);
  } catch (e) {
    throw new PublicInviteError("bad-url", `base64: ${e instanceof Error ? e.message : e}`);
  }
  if (raw[0] === URL_V2) return parseV2(raw);
  if (raw[0] === 0x7b /* '{' */) return parseV1(raw);
  throw new PublicInviteError("bad-url", "unrecognized fragment format");
}

/** Legacy v1 fragment: base64url(JSON) `{ v:1, relays:[...], t:"<hex token>" }`. */
function parseV1(json: Uint8Array): { relays: string[]; token: Uint8Array } {
  const bad = (m: string): never => {
    throw new PublicInviteError("bad-url", m);
  };
  let frag: { v?: number; relays?: unknown; t?: unknown };
  try {
    frag = JSON.parse(new TextDecoder().decode(json));
  } catch (e) {
    return bad(`json: ${e instanceof Error ? e.message : e}`);
  }
  if (frag.v !== 1) return bad(`unsupported url version ${frag.v}`);
  const relays = Array.isArray(frag.relays) ? frag.relays.filter((r): r is string => typeof r === "string") : [];
  if (relays.length > MAX_URL_RELAYS) return bad(`invite url declares too many relays (${relays.length})`);
  if (typeof frag.t !== "string" || !/^[0-9a-fA-F]{64}$/.test(frag.t)) return bad("token must be 64 hex chars");
  return { relays, token: hexToBytes(frag.t) };
}

function parseV2(raw: Uint8Array): { relays: string[]; token: Uint8Array } {
  const bad = (m: string): never => {
    throw new PublicInviteError("bad-url", m);
  };
  if (raw.length < 2) bad("truncated v2 fragment");
  const flags = raw[1];
  let pos = 2;
  let relays: string[];
  if ((flags & V2_FLAG_DEFAULT_RELAYS) !== 0) {
    // No relay bytes — the bundle lives on the stock trusted set.
    relays = [...TRUSTED_RELAYS];
  } else {
    if (pos >= raw.length) bad("truncated v2 relay count");
    const count = raw[pos++];
    if (count === 0 || count > MAX_URL_RELAYS) bad("bad v2 relay count");
    relays = [];
    for (let i = 0; i < count; i++) {
      if (pos >= raw.length) bad("truncated v2 relay entry");
      const id = raw[pos++];
      if (id === 0 || id === 255) {
        if (pos >= raw.length) bad("truncated v2 relay literal");
        const len = raw[pos++];
        const end = pos + len;
        if (end > raw.length) bad("truncated v2 relay literal");
        let host = "";
        for (let j = pos; j < end; j++) host += String.fromCharCode(raw[j]);
        relays.push(id === 0 ? `wss://${host}` : host);
        pos = end;
      } else if (id - 1 < RELAY_DICTIONARY.length) {
        relays.push(RELAY_DICTIONARY[id - 1]);
      }
      // Unknown dictionary id = an entry appended by a NEWER build — skip it
      // (forward-compat); the remaining entries still bootstrap.
    }
    if (relays.length === 0) bad("no resolvable bootstrap relays");
  }
  const tokenBytes = raw.slice(pos);
  if (tokenBytes.length !== 32) bad("v2 token must be exactly 32 bytes");
  return { relays, token: tokenBytes };
}

export { hexToBytes };

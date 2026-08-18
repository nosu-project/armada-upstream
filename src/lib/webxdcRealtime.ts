/**
 * The wire contracts a webxdc realtime channel is made of, shared by both
 * transports (DM and Concord) and by both clients.
 *
 * These are interop surfaces with Vector, so every constant here is a promise
 * to another codebase. A near-match is worse than a mismatch: the two clients
 * join different gossip rooms, each sees one player, and neither reports an
 * error. Vector's implementations live in `crates/vector-core/src/webxdc.rs`
 * and `src-tauri/src/miniapps/realtime.rs`.
 */

import { sha256 } from "@noble/hashes/sha2.js";

/** RFC 4648 base32, no padding — the alphabet Vector encodes topic ids with. */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A topic id is 32 bytes, so its base32 form is always this long. */
export const TOPIC_ID_CHARS = 52;

/** `seq[4 LE] || sender_pubkey[32]` appended to every realtime frame. */
export const TRAILER_LEN = 36;

/** Vector's cap on a peer-advertised address; anything longer is not an address. */
export const MAX_NODE_ADDR_CHARS = 2048;

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buf >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += B32[(buf << (5 - bits)) & 0x1f];
  return out;
}

export function base32Decode(encoded: string): Uint8Array | undefined {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of encoded) {
    const v = B32.indexOf(ch.toUpperCase());
    if (v < 0) return undefined;
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * Vector's receive-side check, matched exactly: 52 characters, uppercase
 * base32 only. A value failing this is dropped rather than propagated, so a
 * UUID in this slot goes silently nowhere.
 */
export function isTopicId(value: string | undefined | null): value is string {
  if (!value || value.length !== TOPIC_ID_CHARS) return false;
  for (const c of value) {
    if (!((c >= "A" && c <= "Z") || (c >= "2" && c <= "7"))) return false;
  }
  return true;
}

/**
 * Mint the topic for an outbound `.xdc`. The sender mints ONCE and puts it on
 * the file event; every participant reads it from there rather than deriving
 * one, because a derived topic is asymmetric in a DM (each side's chat id is
 * the other party's npub) and silently splits the players.
 *
 * Only the output shape is an interop contract, never the recipe, so this
 * differs from Vector's deliberately in one place: Vector mixes a nanosecond
 * clock plus a process counter, the counter being there because its clock
 * reports nanos without resolving them and two sends in a tick minted the same
 * "fresh" topic. `Date.now()` is coarser still, so the entropy here is real
 * random bytes and the collision cannot happen.
 */
export function mintTopicId(fileHash: string, senderHex: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const head = enc.encode(`webxdc-realtime-v1:${fileHash}:${senderHex}:`);
  const buf = new Uint8Array(head.length + salt.length);
  buf.set(head, 0);
  buf.set(salt, head.length);
  return base32Encode(sha256(buf));
}

/**
 * The fallback for a file event carrying no topic tag, byte-identical to
 * Vector's `derive_topic_id`. Note the first input is the manifest NAME: the
 * Rust parameter is called `file_hash`, but both of its call sites pass the
 * name, and the call sites are what the wire sees.
 */
export function deriveTopicId(app: string, chatId: string, messageId: string): string {
  return base32Encode(sha256(new TextEncoder().encode(`webxdc-realtime-v1:${app}:${chatId}:${messageId}`)));
}

/**
 * The topic for a Mini App shared as a bare URL, byte-identical to Vector's
 * `derive_url_topic_id`.
 *
 * The URL is truncated at `.xdc` first, because that is the string Vector
 * hashes: its link regex ends in a LOOKAHEAD for `?`/`#`, so the match stops
 * there and a query string never reaches the hash. Feeding it one produces a
 * different topic and puts the two clients in separate rooms, each seeing a
 * single player, with nothing to report.
 *
 * A pasted `.xdc` link has no file event to carry a minted topic, so every
 * recipient derives the same one from what the message already gives them.
 * The message id, not the bytes: a server can rebuild an identical app into
 * new bytes, and two people who tapped the same card hours apart still belong
 * in one session. Re-sharing the same link is a new message, so it is a new
 * game rather than a surprise seat at the old one.
 */
export function deriveUrlTopicId(url: string, messageId: string): string {
  url = urlTopicSource(url);
  return base32Encode(sha256(new TextEncoder().encode(`webxdc-url-realtime-v1:${url}:${messageId}`)));
}

/** The part of a `.xdc` link that identifies the app: everything up to and
 * including the extension, which is exactly what Vector's regex matches. */
export function urlTopicSource(url: string): string {
  const at = url.toLowerCase().indexOf(".xdc");
  return at === -1 ? url : url.slice(0, at + 4);
}

/** Append Vector's trailer: the payload, then `seq[4 LE] || sender[32]`. */
export function frame(payload: Uint8Array, seq: number, senderKey: Uint8Array): Uint8Array {
  if (senderKey.length !== 32) throw new Error("sender key must be 32 bytes");
  const out = new Uint8Array(payload.length + TRAILER_LEN);
  out.set(payload, 0);
  new DataView(out.buffer).setUint32(payload.length, seq >>> 0, true);
  out.set(senderKey, payload.length + 4);
  return out;
}

export interface Unframed {
  payload: Uint8Array;
  seq: number;
  /** The 32-byte sender key the frame claims, lowercase hex. */
  sender: string;
}

/**
 * Strip the trailer. Anything shorter than the trailer itself is malformed and
 * dropped, exactly as Vector drops it — the frame carries no length prefix, so
 * a short read cannot be told from a truncated one.
 */
export function unframe(content: Uint8Array): Unframed | undefined {
  if (content.length < TRAILER_LEN) return undefined;
  const cut = content.length - TRAILER_LEN;
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  let sender = "";
  for (let i = cut + 4; i < content.length; i++) sender += content[i].toString(16).padStart(2, "0");
  return { payload: content.slice(0, cut), seq: view.getUint32(cut, true), sender };
}

/** A peer signal as it rides a Concord channel (kind 3310, sealed). */
export type PeerSignal =
  | { op: "ad"; topic: string; addr: string }
  | { op: "left"; topic: string };

/** Vector's `peer_signal_content`: the JSON body of a Concord peer signal. */
export function peerSignalContent(topic: string, nodeAddr?: string): string {
  return nodeAddr === undefined
    ? JSON.stringify({ op: "left", topic })
    : JSON.stringify({ op: "ad", topic, addr: nodeAddr });
}

/**
 * Read a peer signal off the 3310 plane. Untrusted wire data from any channel
 * member, so a malformed body is dropped rather than thrown on: one bad signal
 * must not take down the ingest loop for everyone else's.
 */
export function parsePeerSignal(content: string): PeerSignal | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.topic !== "string" || !isTopicId(o.topic)) return undefined;
  if (o.op === "left") return { op: "left", topic: o.topic };
  if (o.op === "ad" && typeof o.addr === "string" && o.addr.length > 0) {
    // Bounded exactly as Vector bounds it. Any member can publish one of
    // these, and an unbounded value would be base32-decoded on the main
    // thread, through an intermediate array, once per re-advertisement.
    if (o.addr.length > MAX_NODE_ADDR_CHARS) return undefined;
    return { op: "ad", topic: o.topic, addr: o.addr };
  }
  return undefined;
}

/** A peer we have seen advertise on a realtime topic. */
export interface RealtimePeer {
  /** The advertiser's pubkey, hex. */
  pubkey: string;
  /** Their iroh endpoint address, opaque to us and passed to the transport. */
  addr: string;
  /** When they last advertised, ms. */
  ms: number;
}

/** One peer signal as it came off a channel, before it is folded. */
export interface PeerSignalEvent {
  author: string;
  content: string;
  ms: number;
}

/**
 * Fold a channel's peer signals into who is currently playing a topic.
 *
 * The signals are durable on purpose (Vector's choice, so a reopening peer
 * backfills a recent ad), which means the fold sees the whole history at once
 * and has to resolve it rather than react to it: last writer per author wins,
 * and a `left` that is newer than that author's last ad removes them. Ordering
 * by `ms` rather than arrival matters, because a backfill delivers an old ad
 * after a newer departure.
 *
 * Signals for other topics are ignored, so one channel can carry several games.
 */
export function foldPeerSignals(
  events: readonly PeerSignalEvent[],
  topic: string,
  /** Our own pubkey, so we never dial ourselves. */
  selfPubkey?: string,
): RealtimePeer[] {
  // The timestamp is the sender's own claim and the fold resolves on it, so an
  // advertisement dated years ahead would outrank its author's every later
  // departure. Vector CLAMPS, which works there because it clamps once at
  // ingest and stores that value; a clamp here would be recomputed against
  // `now` on every fold, so the forged entry would keep winning forever.
  // Folding live, the honest answer is to refuse a signal from the future:
  // a clock skewed past this is not one whose ordering claims are usable.
  const ceiling = Date.now() + 5 * 60_000;
  const latest = new Map<string, { signal: PeerSignal; ms: number }>();
  for (const ev of events) {
    if (ev.ms > ceiling) continue;
    const signal = parsePeerSignal(ev.content);
    if (!signal || signal.topic !== topic) continue;
    if (selfPubkey && ev.author === selfPubkey) continue;
    const prev = latest.get(ev.author);
    // Ties go to the departure: a client that advertises and leaves inside one
    // millisecond has left, and dialling it would hang until timeout.
    if (prev && (prev.ms > ev.ms || (prev.ms === ev.ms && signal.op === "ad"))) continue;
    latest.set(ev.author, { signal, ms: ev.ms });
  }
  const out: RealtimePeer[] = [];
  for (const [pubkey, { signal, ms }] of latest) {
    if (signal.op === "ad") out.push({ pubkey, addr: signal.addr, ms });
  }
  return out.sort((a, b) => b.ms - a.ms);
}

/** Vector's DM peer-signal rumor kind (NIP-78 application-specific data). */
export const KIND_DM_PEER_SIGNAL = 30078;

/** The `d` tag Vector scopes its DM peer signals under. */
export const DM_PEER_SIGNAL_D = "vector-webxdc-peer";

/**
 * The tags of a DM peer signal, as Vector builds them.
 *
 * Armada has no Mini App surface in DMs today, so nothing calls this yet. It
 * lives here because the shape is a contract with another client and belongs
 * beside the Concord one, tested, rather than being rediscovered from Vector's
 * source the day a DM surface exists.
 */
export function dmPeerSignalTags(topic: string, nodeAddr?: string): string[][] {
  const tags = [
    ["d", DM_PEER_SIGNAL_D],
    ["webxdc-topic", topic],
  ];
  if (nodeAddr !== undefined) tags.push(["webxdc-node-addr", nodeAddr]);
  return tags;
}

/** The content of a DM peer signal: the operation is the body, not a field. */
export function dmPeerSignalContent(nodeAddr?: string): string {
  return nodeAddr === undefined ? "peer-left" : "peer-advertisement";
}

/**
 * Read a DM peer signal. Vector requires both tags on an advertisement and
 * drops the rumor otherwise, so this does too.
 */
export function parseDmPeerSignal(content: string, tags: string[][]): PeerSignal | undefined {
  const get = (name: string) => tags.find(([n]) => n === name)?.[1];
  const topic = get("webxdc-topic");
  if (!topic || !isTopicId(topic)) return undefined;
  if (content === "peer-left") return { op: "left", topic };
  if (content === "peer-advertisement") {
    const addr = get("webxdc-node-addr");
    if (addr) return { op: "ad", topic, addr };
  }
  return undefined;
}

/**
 * A node address as it travels: base32 of the JSON, matching Vector's
 * `encode_node_addr`.
 *
 * The pair exists so the two directions cannot drift apart. Publishing the raw
 * JSON while decoding base32 on receipt fails in a way nothing reports: the
 * far side's decoder rejects the address and drops the advertisement before it
 * is ever recorded, so the peer stays invisible in the lobby while the game
 * itself plays fine, because whoever could read an address dialled first.
 */
export function encodeNodeAddr(addrJson: string): string {
  return base32Encode(new TextEncoder().encode(addrJson));
}

/** Undo {@link encodeNodeAddr}; undefined if it is not base32 of valid JSON. */
export function decodeNodeAddr(encoded: string): string | undefined {
  const bytes = base32Decode(encoded);
  if (!bytes) return undefined;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(json);
    return json;
  } catch {
    return undefined;
  }
}

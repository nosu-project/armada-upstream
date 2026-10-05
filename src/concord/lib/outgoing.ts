/**
 * Concord sends no relay has yet been seen to hold, persisted per viewer.
 *
 * A record is deleted on the first evidence the rumor is STORED on a relay: a
 * read-back by id (`outgoingVerify.ts`) after an OK, since some relays accept
 * and drop, or the rumor arriving through any relay read. Holds plaintext, so
 * it is purged on logout (`resetKvCaches`).
 */
import { KvPrefixCache } from "@/lib/db/kvCache";

import type { NostrEvent } from "nostr-tools/pure";
import type { OpenedChat } from "@/concord/lib/chat";
import type { SendStatus, SendStatusMap } from "@/hooks/useSendStatusMap";

export type OutgoingState = "signing" | "sending" | "verifying" | "failed";

export interface OutgoingRecord {
  rumorId: string;
  viewer: string;
  communityIdHex: string;
  channelIdHex: string;
  kind: number;
  content: string;
  /** The rumor's tags WITHOUT the `ms` tag `buildRumor` appends, so a re-seal reproduces the id. */
  tags: string[][];
  ms: number;
  createdAt: number;
  /** bigint as a decimal string: the record is JSON at rest. */
  epoch: string;
  state: OutgoingState;
  /** The signed wrap once sealed; re-broadcast as-is so relays dedupe it. */
  wrap?: NostrEvent;
  relays: string[];
  /** Set once a relay said OK: the read-back is due then (unix ms). */
  verifyAt?: number;
  /** Relays that said OK, so a read-back that misses can be held against them. */
  acked?: string[];
  /** Re-broadcasts after a read-back found the wrap nowhere. */
  verifyAttempts?: number;
  updatedAt: number;
}

const cache = new KvPrefixCache<OutgoingRecord>({ prefix: "c2out:" });

/**
 * A signer that answers within this long never shows "pending". Only a LOCAL
 * signer may defer persisting until the mark: a page that dies inside the
 * window loses an unwritten send.
 */
export const PENDING_GRACE_MS = 300;

/** `signing` records inside the grace window; `persisted` false = in memory only. */
const signingGrace = new Map<
  string,
  { record: OutgoingRecord; persisted: boolean; timer: ReturnType<typeof setTimeout> }
>();
/** Rumors whose signer request or broadcast is running in THIS page. */
const live = new Set<string>();
/** Relay sightings that arrived before the warm; applied when it lands. Bounded: boot sync is traffic. */
const confirmedBeforeWarm = new Set<string>();
const CONFIRMED_BEFORE_WARM_CAP = 20_000;

let revision = 0;
const listeners = new Set<() => void>();

function bump(): void {
  revision++;
  for (const l of listeners) {
    try {
      l();
    } catch {
      // A listener must never break a write.
    }
  }
}
cache.subscribe(() => {
  if (cache.warmed && confirmedBeforeWarm.size > 0) {
    const early = [...confirmedBeforeWarm];
    confirmedBeforeWarm.clear();
    confirmOutgoing(early);
  }
  bump();
});

/** Subscribing kicks the warm. */
export function subscribeOutgoing(listener: () => void): () => void {
  void cache.ready();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function outgoingRevision(): number {
  return revision;
}

export function outgoingReady(): Promise<void> {
  return cache.ready();
}

export function getOutgoing(rumorId: string): OutgoingRecord | undefined {
  return signingGrace.get(rumorId)?.record ?? cache.get(rumorId);
}

/** Every record of `viewer`, oldest first. Persisted ones are empty before the warm lands. */
export function outgoingFor(viewer: string): OutgoingRecord[] {
  const out: OutgoingRecord[] = [];
  for (const { record, persisted } of signingGrace.values()) if (!persisted && record.viewer === viewer) out.push(record);
  for (const id of cache.ids()) {
    const r = cache.get(id);
    if (r && r.viewer === viewer) out.push(signingGrace.get(id)?.record ?? r);
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function endGrace(rumorId: string): void {
  const held = signingGrace.get(rumorId);
  if (!held) return;
  clearTimeout(held.timer);
  signingGrace.delete(rumorId);
}

/**
 * Record (or advance) a send. `liveNow` marks the attempt as running in this
 * page; `deferPersist` (local signers only) skips the KV write for a `signing`
 * stage the signer finishes inside the grace.
 */
export function putOutgoing(record: OutgoingRecord, liveNow = true, opts?: { deferPersist?: boolean }): void {
  if (liveNow) live.add(record.rumorId);
  else live.delete(record.rumorId);
  const next = { ...record, updatedAt: Date.now() };
  endGrace(record.rumorId);
  if (next.state === "signing" && liveNow) {
    const persisted = !opts?.deferPersist;
    if (persisted) cache.set(next.rumorId, next);
    // At the mark: show pending, and write the record if it was deferred.
    const timer = setTimeout(() => {
      const held = signingGrace.get(next.rumorId);
      if (!held) return;
      signingGrace.delete(next.rumorId);
      if (held.persisted) bump();
      else cache.set(next.rumorId, held.record);
    }, PENDING_GRACE_MS);
    signingGrace.set(next.rumorId, { record: next, persisted, timer });
    return;
  }
  cache.set(next.rumorId, next);
}

/** Patch a persisted record in place (no-op when it's gone). */
export function updateOutgoing(rumorId: string, patch: Partial<OutgoingRecord>): void {
  const rec = cache.get(rumorId);
  if (rec) cache.set(rumorId, { ...rec, ...patch, updatedAt: Date.now() });
}

/** Every persisted record awaiting a read-back, any viewer. */
export function outgoingAwaitingVerify(): OutgoingRecord[] {
  return cache
    .ids()
    .map((id) => cache.get(id)!)
    .filter((r) => r && r.verifyAt !== undefined && r.wrap);
}

export function failOutgoing(rumorId: string): void {
  live.delete(rumorId);
  const rec = getOutgoing(rumorId);
  endGrace(rumorId);
  if (rec && rec.state !== "failed") cache.set(rumorId, { ...rec, state: "failed", updatedAt: Date.now() });
  else bump();
}

export function isOutgoingLive(rumorId: string): boolean {
  return live.has(rumorId);
}

/** Mark an attempt running again (a retry or a resumed re-broadcast). */
export function markOutgoingLive(rumorId: string): void {
  live.add(rumorId);
  bump();
}

/**
 * The rumors are on a relay: forget them. Cheap on a miss (the common case),
 * and never starts the warm itself — the service worker ingests too, and has no
 * reader for these records.
 */
export function confirmOutgoing(rumorIds: Iterable<string>): void {
  for (const id of rumorIds) {
    const held = signingGrace.get(id);
    if (held && !held.persisted) {
      endGrace(id);
      live.delete(id);
      bump();
      continue;
    }
    endGrace(id);
    if (!cache.warmed && confirmedBeforeWarm.size < CONFIRMED_BEFORE_WARM_CAP) confirmedBeforeWarm.add(id);
    const rec = cache.get(id);
    if (rec === undefined) continue;
    // A read can be a relay echoing what it won't keep: the read-back settles these.
    if (rec.verifyAt !== undefined) continue;
    live.delete(id);
    cache.delete(id);
  }
}

/** Forget a record outright: discarded by the user, or read back from a relay. */
export function forgetOutgoing(rumorId: string): void {
  endGrace(rumorId);
  live.delete(rumorId);
  if (cache.get(rumorId) !== undefined) cache.delete(rumorId);
  else bump();
}

export const discardOutgoing = forgetOutgoing;

/**
 * What a row shows: `pending` only while this page waits on the signer past
 * the grace (a dead relay must not hold a spinner); `failed` once an attempt
 * gave up, or for a signer request that died with an earlier page.
 */
export function outgoingStatus(rec: OutgoingRecord): SendStatus | undefined {
  if (rec.state === "failed") return "failed";
  if (rec.state === "signing") {
    if (signingGrace.has(rec.rumorId)) return undefined;
    return live.has(rec.rumorId) ? "pending" : "failed";
  }
  return undefined;
}

// Selectors return the SAME object until their content changes, so a send
// that never surfaces a status re-renders nothing (useSyncExternalStore).

const EMPTY_STATUS: SendStatusMap = {};
const lastStatus = new Map<string, SendStatusMap>();

function sameStatus(a: SendStatusMap, b: SendStatusMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** Status by rumor id for one channel; identity-stable while its content is. */
export function outgoingStatusMap(viewer: string | undefined, channelIdHex: string | null): SendStatusMap {
  if (!viewer || !channelIdHex) return EMPTY_STATUS;
  const next: SendStatusMap = {};
  for (const rec of outgoingFor(viewer)) {
    if (rec.channelIdHex !== channelIdHex) continue;
    const s = outgoingStatus(rec);
    if (s) next[rec.rumorId] = s;
  }
  const key = `${viewer}:${channelIdHex}`;
  const prev = lastStatus.get(key) ?? EMPTY_STATUS;
  if (sameStatus(prev, next)) return prev;
  const value = Object.keys(next).length > 0 ? next : EMPTY_STATUS;
  lastStatus.set(key, value);
  return value;
}

const EMPTY_ROWS: OpenedChat[] = [];
const lastRows = new Map<string, OpenedChat[]>();

/**
 * Rows for sends that never sealed: they exist nowhere but here, so the
 * timeline adds them. Sealed sends are in the rumor store already. A rumor
 * id's row never changes, so the same ids mean the same array.
 */
export function unsealedOutgoingRows(viewer: string | undefined, channelIdHex: string | null): OpenedChat[] {
  if (!viewer || !channelIdHex) return EMPTY_ROWS;
  const records = outgoingFor(viewer).filter((r) => r.channelIdHex === channelIdHex && !r.wrap);
  const key = `${viewer}:${channelIdHex}`;
  const prev = lastRows.get(key) ?? EMPTY_ROWS;
  if (prev.length === records.length && prev.every((row, i) => row.rumorId === records[i].rumorId)) return prev;
  const rows = records.length > 0 ? records.map(recordToRow) : EMPTY_ROWS;
  lastRows.set(key, rows);
  return rows;
}

export function recordToRow(rec: OutgoingRecord): OpenedChat {
  return {
    rumorId: rec.rumorId,
    author: rec.viewer,
    kind: rec.kind,
    content: rec.content,
    tags: rec.tags,
    ms: rec.ms,
    createdAt: rec.createdAt,
    channelIdHex: rec.channelIdHex,
    epoch: BigInt(rec.epoch),
    // Placeholders: an unsealed row has no envelope (see `isUnsealedRow`).
    wrapId: "",
    streamPk: "",
  };
}

/** An optimistic row whose seal was never signed: shown, never persisted as a message. */
export function isUnsealedRow(row: Pick<OpenedChat, "wrapId">): boolean {
  return row.wrapId === "";
}

/** The `ms` tag `buildRumor` appends; stripped so a re-seal reproduces the rumor id. */
export function withoutMsTag(tags: string[][]): string[][] {
  return tags.filter((t) => t[0] !== "ms");
}

/** Logout: forget which attempts were running (the KV map is reset by `resetKvCaches`). */
export function clearOutgoingMemory(): void {
  for (const { timer } of signingGrace.values()) clearTimeout(timer);
  signingGrace.clear();
  live.clear();
  confirmedBeforeWarm.clear();
  lastStatus.clear();
  lastRows.clear();
  bump();
}

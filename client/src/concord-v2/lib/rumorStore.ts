/**
 * Concord V2 rumor cache — the decrypted chat store.
 *
 * V2 chat traffic arrives as opaque kind-1059 wraps (CORD-01). Caching those
 * ciphertext wraps is wasteful: every cold read has to re-run two NIP-44 opens
 * and a Schnorr verify per message to recover anything renderable. Instead we
 * decrypt once on ingest and persist the recovered RUMOR here — a signature-less
 * event (`sig: ""`) carrying its real kind / author / content / tags — so the
 * timeline reads back with ordinary Nostr filters and no decrypt:
 *
 *   store.query([{ kinds: [9], "#channel": [channelIdHex], limit }])
 *
 * Backed by `@nostrify/indexeddb` (the strfry-port NStore), a SEPARATE database
 * from the shared `armada-events` cache so its query engine, its custom tag
 * index, and — crucially — its NIP-09 deletion semantics stay isolated from
 * everything else.
 *
 * Deletes ARE deletes: a kind-5 rumor written here triggers the store's NIP-09
 * pass, which physically removes the targeted rumor (self-authored only — the
 * store refuses to delete another author's event). Moderator deletes are
 * authorized against the roster at the WRITE site (see `useChannel2`) before the
 * kind-5 rumor is ever handed to the store, so the store's own self-only NIP-09
 * check is the second gate, not the only one.
 *
 * Trust note: this persists DECRYPTED chat plaintext at rest — the same
 * device-trust level as the folded cache and the signer's decrypt cache, which
 * already do. Anyone with local storage access already holds the channel keys.
 * The database is wiped alongside the others on logout (see purgeClientStorage).
 */

import { NIndexedDB } from "@nostrify/indexeddb";
import type { NostrEvent } from "@nostrify/nostrify";

import { readFolded, writeFolded } from "@/lib/foldedCache";
import { resolveMs, type Rumor } from "@/concord-v2/lib/stream";
import type { OpenedChat } from "@/concord-v2/lib/chat";

const DB_NAME = "armada-concord-rumors";

/** Tag names we must be able to query rumors by. */
const QUERYABLE_TAGS = new Set(["channel", "e", "q", "p", "k"]);

/**
 * Index the tags chat queries need. The default NIndexedDB policy only indexes
 * SINGLE-letter tags, but our binding tag is `channel` (multi-letter), so a
 * `{ "#channel": [...] }` filter would match nothing without this. Index every
 * single-letter tag (as usual) PLUS our explicit multi-letter query tags.
 */
function indexTags(event: NostrEvent): string[][] {
  return event.tags.filter(
    ([name, value]) =>
      typeof name === "string" &&
      typeof value === "string" &&
      value.length > 0 &&
      value.length < 200 &&
      (name.length === 1 || QUERYABLE_TAGS.has(name)),
  );
}

let store: NIndexedDB | undefined;

/** The singleton rumor store (opens the DB in the background on first use). */
export function rumorStore(): NIndexedDB {
  if (!store) store = new NIndexedDB(DB_NAME, { indexTags });
  return store;
}

/** Warm the IndexedDB connection so the first channel open reads a hot store. */
export function warmRumorStore(): void {
  try {
    void rumorStore()
      .query([{ kinds: [9], limit: 1 }])
      .catch(() => undefined);
  } catch {
    // IndexedDB unavailable — the store degrades to a no-op.
  }
}

// ── Codec: OpenedChat ⇆ stored rumor event ───────────────────────────────────
//
// The stored event IS the recovered rumor (its `id` is the rumor id, the NIP-01
// hash), with `sig: ""`. The chat read path never re-wraps a chat rumor (only
// the control plane does), so the seal/stream provenance an `OpenedChat` carries
// for compaction is NOT persisted; it's stubbed on read. Everything the timeline
// fold and the UI actually read — kind, author, content, tags, ms, channel,
// epoch — round-trips exactly.

/** Build the stored rumor event for an opened chat event. */
export function openedToStored(opened: OpenedChat): NostrEvent {
  const rumor: Rumor = {
    id: opened.rumorId,
    kind: opened.kind,
    content: opened.content,
    tags: opened.tags,
    created_at: opened.createdAt,
    pubkey: opened.author,
  };
  // `channel` + `epoch` binding tags are already inside `tags` (a Chat rumor
  // MUST commit them, CORD-03 §3), so `#channel` queries work with no extra
  // derived fields. Persist with an empty signature — the store never verifies.
  return { ...rumor, sig: "" };
}

/** Rebuild an OpenedChat from a stored rumor event. */
export function storedToOpened(ev: NostrEvent, channelIdHex: string): OpenedChat {
  const epochTag = ev.tags.find((t) => t[0] === "epoch")?.[1];
  return {
    rumorId: ev.id,
    author: ev.pubkey,
    kind: ev.kind,
    content: ev.content,
    tags: ev.tags,
    ms: resolveMs(ev.created_at, ev.tags),
    createdAt: ev.created_at,
    // Chat never re-wraps, so stream provenance is not persisted.
    wrapId: "",
    streamPk: "",
    sealKind: 0,
    seal: ev,
    channelIdHex,
    epoch: epochTag ? BigInt(epochTag) : 0n,
  };
}

// ── Reads / writes ────────────────────────────────────────────────────────────

/** All chat-plane rumor kinds we persist and fold. */
const CHAT_KINDS = [5, 7, 9, 3302];

/**
 * Read a channel's cached rumors, newest-first up to `limit`, as OpenedChats.
 * A `channel` tag query hits the tag index directly. `before` (a `created_at`
 * upper bound, exclusive) pages older history out of the store.
 */
export async function queryChannelRumors(
  channelIdHex: string,
  opts: { limit: number; before?: number; signal?: AbortSignal },
): Promise<OpenedChat[]> {
  const filter: {
    kinds: number[];
    "#channel": string[];
    limit: number;
    until?: number;
  } = { kinds: CHAT_KINDS, "#channel": [channelIdHex], limit: opts.limit };
  if (opts.before !== undefined) filter.until = opts.before - 1;
  const events = await rumorStore().query([filter], { signal: opts.signal });
  return events.map((ev) => storedToOpened(ev, channelIdHex));
}

/** How many rumors are cached for a channel (used to decide "widen vs backfill"). */
export async function countChannelRumors(channelIdHex: string): Promise<number> {
  const { count } = await rumorStore().count([{ kinds: CHAT_KINDS, "#channel": [channelIdHex] }]);
  return count;
}

/**
 * Persist opened chat events as rumors (fire-and-forget). Kind-5 deletes trigger
 * the store's self-only NIP-09 removal of their targets. Failures are swallowed.
 */
export function writeRumors(opened: OpenedChat[]): void {
  if (opened.length === 0) return;
  const s = rumorStore();
  void Promise.all(opened.map((o) => s.event(openedToStored(o)))).catch(() => {
    // Best-effort cache.
  });
}

// ── Sync cursor ───────────────────────────────────────────────────────────────
//
// Per-channel resume state, persisted in the folded IndexedDB cache so a cold
// launch resumes sync instead of re-paging the newest window every time. Kept
// tiny (three numbers per channel).

/** A channel's persisted sync position. */
export interface ChannelCursor {
  /** `created_at` of the newest wrap we've ingested (the live-sub `since` floor). */
  newest: number;
  /** `created_at` of the oldest wrap we've paged back to (the backfill `until`). */
  oldest: number;
  /** No relay had deeper history past `oldest` — stop issuing older-backfills. */
  exhausted: boolean;
}

const cursorKey = (channelIdHex: string) => `concord2-cursor:${channelIdHex}`;

/** Read a channel's sync cursor, or undefined if none has been saved yet. */
export function readChannelCursor(channelIdHex: string): Promise<ChannelCursor | undefined> {
  return readFolded<ChannelCursor>(cursorKey(channelIdHex));
}

/**
 * Merge new sync progress into a channel's cursor (best-effort). `newest` only
 * ever advances forward, `oldest` only ever recedes, `exhausted` is sticky
 * until an epoch change clears it (a new stream key may unlock more history).
 */
export async function updateChannelCursor(
  channelIdHex: string,
  patch: Partial<ChannelCursor>,
): Promise<void> {
  const prev = await readChannelCursor(channelIdHex);
  const next: ChannelCursor = {
    newest: Math.max(prev?.newest ?? 0, patch.newest ?? 0),
    oldest:
      patch.oldest !== undefined
        ? prev?.oldest
          ? Math.min(prev.oldest, patch.oldest)
          : patch.oldest
        : (prev?.oldest ?? 0),
    exhausted: patch.exhausted ?? prev?.exhausted ?? false,
  };
  await writeFolded(cursorKey(channelIdHex), next);
}

/** Clear the exhausted flag (e.g. after a rekey catch-up unlocks older history). */
export async function clearChannelExhausted(channelIdHex: string): Promise<void> {
  const prev = await readChannelCursor(channelIdHex);
  if (prev?.exhausted) await writeFolded(cursorKey(channelIdHex), { ...prev, exhausted: false });
}

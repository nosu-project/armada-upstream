/**
 * NIP-17 opened-DM cache — the decrypted store for the modern DM plane.
 *
 * Gift wraps are NEVER persisted (NostrBatcher already drops kind 1059 from
 * the shared cache): caching ciphertext would re-run two NIP-44 opens per
 * event on every cold read. Instead, wraps are opened once on sync and the
 * recovered rumor is persisted here as a signature-less event carrying its
 * real kind / author / content / tags, plus conversation provenance folded
 * into synthetic tags:
 *
 *   `peer` — the conversation partner (how threads and the list query);
 *   `wrap` — the carrier wrap id (debugging/provenance only).
 *
 * Backed by one ArmadaDB tenant PER VIEWER (`dm17:<self>`). Every read and
 * write names the account it is for, so one logged-in profile's decrypted
 * messages are not merely filtered out of another's reads — they are in a
 * different database. (The store this replaced was global, keyed only by
 * `peer`, and account isolation rested on nothing.)
 *
 * Deletes ARE deletes: a kind-5 rumor written here triggers the store's
 * self-only NIP-09 pass, physically removing the targeted rumor its author
 * wrote — a peer deletes their own messages/reactions, never ours.
 *
 * So are expirations. A rumor carrying a passed NIP-40 `expiration`
 * (disappearing messages) is refused on write and filtered out of every read,
 * and {@link sweepExpiredDm17Rumors} physically removes the ones that expired
 * while they sat here. The read filter is the backstop, not the mechanism:
 * "disappeared" has to mean gone from disk, not merely hidden.
 *
 * Trust note: this persists DECRYPTED messages at rest — the same device-trust
 * level as the DM thread snapshots and the signer's decrypt cache. Wiped on
 * logout (see purgeClientStorage).
 */

import { NIndexedDB } from "@nostrify/indexeddb";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { getArmadaDB } from "@/lib/db/armadaDB";
import { skipLegacyDrain } from "@/lib/db/legacyDatabases";
import type { NRumorStore } from "@/lib/db/types";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import type { NostrRumor } from "@/lib/nostrRumor";
import {
  DM_RUMOR_KINDS,
  dmPeerOf,
  isExpired,
  KIND_DM_CHAT,
  KIND_DM_FILE,
  KIND_DM_TIMER,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import { emitWireScopes } from "@/wire/bus";

/** The global pre-tenant database, drained into the tenants on first use. */
const LEGACY_DB_NAME = "armada-dm17-rumors";

/**
 * Tag names earlier builds INJECTED onto the stored event. Nothing writes them
 * any more; they are dropped from anything copied out of the legacy database.
 *
 * A rumor's tags are the bytes its id commits to, so rewriting them to carry
 * bookkeeping made the stored row something its sender never signed — and made
 * the store's idea of a conversation forgeable by anyone who spelled `peer`
 * themselves. Neither value needed a tag: NIP-17 requires the rumor to name its
 * recipients in `p`, so the partner is always derivable ({@link dmPeerOf}), and
 * nothing on this side of the store reads a wrap id.
 */
const PROVENANCE = new Set(["peer", "wrap"]);

/**
 * The opened-DM store for one account. ArmadaDB's default tag policy indexes
 * the multi-letter `peer` these queries need.
 */
export function dm17Store(self: string): NRumorStore {
  return getArmadaDB().tenant(`dm17:${self}`);
}

// ── Legacy drain ────────────────────────────────────────────────────────────
//
// DMs used to live in one global database keyed only by `peer` — it never
// recorded WHICH account opened a rumor. Dropping it on upgrade would lose DM
// history for good (re-decrypting means refetching gift wraps relays may have
// already dropped), but copying it wholesale into the first account that reads
// would hand that account another profile's messages — the leak the per-viewer
// tenant exists to make impossible.
//
// So records are attributed before they move. A NIP-17 message names the
// author in `pubkey` and its recipients in `p` tags, so `self` is one of the
// two. Reactions and deletes name neither, but they carry an `e` pointing at
// what they act on — so they come across when that target did. Attributing
// them by shared `peer` instead would be wrong: two accounts on one device can
// both have talked to the same person, and every record in that conversation
// would then match both. On the ordinary single-account install everything
// qualifies either way.

/**
 * Records read per page of the newest-first scan.
 *
 * The whole store is read, not a single capped query: attribution needs every
 * record at once (a delete of a reaction of a message is only attributable
 * once its target is), so pages are accumulated rather than processed one by
 * one. This is a page size, not a ceiling on what is copied.
 */
export const DM17_DRAIN_PAGE = 500;

/**
 * Pages a single drain will walk. A store this deep is far past any real DM
 * history; hitting the bound means something is wrong with the paging, and the
 * drain FAILS rather than copying a prefix and letting the gate delete the
 * rest.
 */
const DRAIN_MAX_PAGES = 2_000;

const DRAIN_KEY = (self: string) => `dm17:migrated:${self}`;

/** In-flight/settled drains, so concurrent reads share one pass. */
const drains = new Map<string, Promise<void>>();

/**
 * Copy `self`'s share of the legacy database across. Idempotent and memoised.
 *
 * REJECTS on failure: the startup gate deletes the legacy database only once
 * every drain has resolved for every account, so a drain that swallowed its
 * error and resolved would have the gate delete DM history nobody copied.
 * Every caller in this module already guards the call.
 */
export function migrateLegacyDms(self: string): Promise<void> {
  let drain = drains.get(self);
  if (!drain) {
    drain = drainLegacyDms(self).catch((err: unknown) => {
      // Drop the memo so a later read retries: writes are keyed by rumor id,
      // so recopying what already landed costs nothing.
      drains.delete(self);
      throw err;
    });
    drains.set(self, drain);
  }
  return drain;
}

/** Whether a stored record names `self` outright (author or recipient). */
function namesSelf(ev: NostrEvent, self: string): boolean {
  return ev.pubkey === self || ev.tags.some(([name, value]) => name === "p" && value === self);
}

/** Every legacy record, newest first, paged so a deep history isn't truncated. */
async function readLegacyDms(legacy: NIndexedDB): Promise<NostrEvent[]> {
  const all: NostrEvent[] = [];
  const seen = new Set<string>();
  let until: number | undefined;

  for (let page = 0; page < DRAIN_MAX_PAGES; page++) {
    const filter: { kinds: number[]; limit: number; until?: number } = {
      kinds: DM_RUMOR_KINDS,
      limit: DM17_DRAIN_PAGE,
    };
    if (until !== undefined) filter.until = until;
    const rows = await legacy.query([filter]);
    // Ties on `created_at` make pages overlap, so progress is measured in NEW
    // ids rather than in rows returned.
    const fresh = rows.filter((ev) => !seen.has(ev.id));
    if (fresh.length === 0) return all;
    for (const ev of fresh) {
      seen.add(ev.id);
      all.push(ev);
    }
    if (rows.length < DM17_DRAIN_PAGE) return all;
    until = Math.min(...rows.map((ev) => ev.created_at));
  }

  throw new Error("dm17 legacy drain exceeded its page bound");
}

async function drainLegacyDms(self: string): Promise<void> {
  const db = getArmadaDB();
  const key = DRAIN_KEY(self);
  if (await db.kv.get<boolean>(key)) return;
  // `NIndexedDB` CREATES the database on its first query, which would leave a
  // device that never had one with the very database the startup gate scans
  // for. See `skipLegacyDrain`.
  if (await skipLegacyDrain(LEGACY_DB_NAME)) return;

  const legacy = new NIndexedDB(LEGACY_DB_NAME);
  try {
    const all = await readLegacyDms(legacy);

    // Pass one: records that name `self` outright.
    const mine = new Set<string>();
    for (const ev of all) {
      if (namesSelf(ev, self)) mine.add(ev.id);
    }
    // Pass two: reactions/deletes pointing at something already attributed.
    // Repeated to a fixpoint so a delete of a reaction of a message follows
    // the chain; `all` is finite and `mine` only grows, so this terminates.
    for (;;) {
      let added = false;
      for (const ev of all) {
        if (mine.has(ev.id)) continue;
        const targets = ev.tags.filter(([name]) => name === "e").map(([, value]) => value);
        if (targets.some((id) => mine.has(id))) {
          mine.add(ev.id);
          added = true;
        }
      }
      if (!added) break;
    }

    const tenant = dm17Store(self);
    for (const ev of all) {
      if (!mine.has(ev.id)) continue;
      const { sig: _sig, ...rumor } = ev;
      // The legacy rows carry the tags that store injected. Dropping them is
      // what makes every row this store holds the rumor its sender signed —
      // and nothing is lost with them: attribution comes from `pubkey` and the
      // `p` tags NIP-17 requires, which is what the passes above just used.
      await tenant.event({ ...rumor, tags: rumor.tags.filter((t) => !PROVENANCE.has(t[0])) });
    }
  } finally {
    await legacy.close().catch(() => undefined);
  }

  await db.kv.set(key, true);
}

// ── Codec: OpenedDm ⇆ stored event ───────────────────────────────────────────

/** Build the stored rumor for an opened DM: the rumor itself, unaltered. */
export function dm17ToStored(opened: OpenedDm): NostrRumor {
  return {
    id: opened.rumorId,
    kind: opened.kind,
    content: opened.content,
    tags: opened.tags,
    created_at: opened.createdAt,
    pubkey: opened.author,
  };
}

/**
 * Reconstruct an OpenedDm from a stored rumor, as seen by `self`.
 *
 * The conversation partner is DERIVED from the rumor — see {@link dmPeerOf} —
 * which is why nothing has to be injected on the way in. `wrapId` is not
 * recoverable and nothing consumes it; the transport dedupes on wraps it holds
 * in hand.
 */
export function storedToDm17(ev: NostrRumor, self: string): OpenedDm {
  return {
    rumorId: ev.id,
    author: ev.pubkey,
    kind: ev.kind,
    content: ev.content,
    tags: ev.tags,
    createdAt: ev.created_at,
    peer: dmPeerOf(ev, self) ?? "",
    wrapId: "",
  };
}

// ── Reads / writes ────────────────────────────────────────────────────────────

/**
 * Persist opened DM rumors, then ring the wire bus's `dm` scope so every DM
 * surface (thread, conversation list, unread dot) re-reads. Kind-5 rumors
 * trigger the store's self-only NIP-09 removal of their targets. Best-effort;
 * resolves once the write commits.
 */
export async function writeDm17Rumors(self: string, opened: OpenedDm[]): Promise<void> {
  // Already-expired rumors never reach persistent storage. `openDmWrap` also
  // rejects them, but this is the single choke point every writer goes through
  // (sync, backfill, our own optimistic sends), so it's where the guarantee
  // belongs: a disappearing message that arrives late is simply never stored.
  const fresh = opened.filter((o) => !isExpired(o.tags));
  if (fresh.length === 0) return;
  const s = dm17Store(self);
  await Promise.all(
    fresh.map((o) =>
      s.event(dm17ToStored(o)).catch(() => {
        // Duplicate or rejected — the store's state is authoritative.
      }),
    ),
  );
  emitWireScopes(["dm"]);
}

/**
 * Read one conversation's cached rumors (messages, reactions, deletes),
 * newest-first up to `limit`. `before` (exclusive `created_at` upper bound)
 * pages older history out of the store.
 */
export async function queryDm17Thread(
  self: string,
  peer: string,
  opts: { limit: number; before?: number; signal?: AbortSignal },
): Promise<OpenedDm[]> {
  await migrateLegacyDms(self).catch(() => undefined);
  const events = await dm17Store(self).query(
    conversationFilters(self, peer, { limit: opts.limit, before: opts.before }),
    { signal: opts.signal },
  );
  return events
    .filter((ev) => !isExpired(ev.tags))
    .map((ev) => storedToDm17(ev, self))
    .slice(0, opts.limit);
}

/**
 * The filters selecting one conversation, from `self`'s side.
 *
 * A conversation is two directions and they are indexed differently: what the
 * peer sent names them as the AUTHOR, what we sent names them in a `p` tag. The
 * two are OR'd, so each is an ordinary indexed lookup — the author scan on
 * `(tenant, pubkey)`, ours on the `p` tag token — and the store merges and
 * de-duplicates them.
 *
 * Each filter carries the full limit, so the union can be up to twice it; the
 * caller slices after the merge has put them in order.
 */
function conversationFilters(
  self: string,
  peer: string,
  opts: { limit?: number; before?: number } = {},
): NostrFilter[] {
  const bounds: { limit?: number; until?: number } = {};
  if (opts.limit !== undefined) bounds.limit = opts.limit;
  if (opts.before !== undefined) bounds.until = opts.before - 1;

  return [
    { kinds: DM_RUMOR_KINDS, authors: [peer], ...bounds },
    { kinds: DM_RUMOR_KINDS, authors: [self], "#p": [peer], ...bounds },
  ];
}

/**
 * The conversation's current disappearing-messages timer in seconds (0 = off),
 * or undefined when neither side has ever set one.
 *
 * Read as its own single-row query rather than off the thread window: a timer
 * set months ago is still in force today, and the thread only reads back the
 * newest few hundred rumors. Timer rumors never expire, so the newest one is
 * always the live setting — whichever participant sent it.
 */
export async function queryDm17Timer(
  self: string,
  peer: string,
  opts: { signal?: AbortSignal } = {},
): Promise<number | undefined> {
  await migrateLegacyDms(self).catch(() => undefined);
  const events = await dm17Store(self).query(
    conversationFilters(self, peer, { limit: 1 }).map((f) => ({ ...f, kinds: [KIND_DM_TIMER] })),
    { signal: opts.signal },
  );
  const raw = events[0]?.tags.find((t) => t[0] === "timer")?.[1];
  if (raw === undefined) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? Math.floor(secs) : undefined;
}

/**
 * The newest chat/file rumor per conversation partner — the NIP-17 side of
 * the conversation list. Reads the newest `limit` message rumors and groups
 * client-side (fine at DM scale; reactions/deletes never surface a peer).
 *
 * `mine` marks conversations the viewer has participated in (authored at least
 * one message to), so the list can keep a thread you started with someone you
 * don't follow.
 */
export async function queryDm17Conversations(
  self: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<Array<{ peer: string; latest: OpenedDm; mine: boolean }>> {
  await migrateLegacyDms(self).catch(() => undefined);
  const events = await dm17Store(self).query(
    [{ kinds: [KIND_DM_CHAT, KIND_DM_FILE], limit: opts.limit ?? 500 }],
    { signal: opts.signal },
  );
  const byPeer = new Map<string, OpenedDm>();
  const mine = new Set<string>();
  for (const ev of events) {
    if (isExpired(ev.tags)) continue;
    const opened = storedToDm17(ev, self);
    if (!opened.peer) continue;
    if (opened.author === self) mine.add(opened.peer);
    const cur = byPeer.get(opened.peer);
    if (!cur || opened.createdAt > cur.createdAt) byPeer.set(opened.peer, opened);
  }
  return [...byPeer.entries()]
    .map(([peer, latest]) => ({ peer, latest, mine: mine.has(peer) }))
    .sort((a, b) => b.latest.createdAt - a.latest.createdAt);
}

/**
 * Every locally-cached chat/file rumor whose decrypted content matches
 * `query` (case-insensitive substring), across all conversation partners.
 * Purely local — the rumors are already decrypted at rest, so this never
 * prompts the signer. Newest-first, capped at `limit` matches.
 */
export async function searchDm17Rumors(
  self: string,
  query: string,
  opts: { limit?: number; scan?: number; signal?: AbortSignal } = {},
): Promise<OpenedDm[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  await migrateLegacyDms(self).catch(() => undefined);
  const events = await dm17Store(self).query(
    [{ kinds: [KIND_DM_CHAT, KIND_DM_FILE], limit: opts.scan ?? 2000 }],
    { signal: opts.signal },
  );
  const matches = events
    .filter((ev) => !isExpired(ev.tags))
    .map((ev) => storedToDm17(ev, self))
    .filter((o) => o.peer && o.content.toLowerCase().includes(needle))
    .sort((a, b) => b.createdAt - a.createdAt);
  return matches.slice(0, opts.limit ?? 200);
}

// ── Expiry sweep ─────────────────────────────────────────────────────────────

/** Rumors scanned per sweep page. */
const SWEEP_PAGE = 1000;
/** Pages a single sweep will walk (bounds a huge history to a bounded cost). */
const SWEEP_MAX_PAGES = 20;

/**
 * Physically remove every stored rumor whose NIP-40 `expiration` has passed.
 *
 * Read paths filter expired rumors out too, but hiding is not disappearing:
 * the plaintext has to leave IndexedDB. `expiration` is a multi-letter tag and
 * is not indexed (and a range query over it wouldn't exist anyway), so this
 * walks the store newest-first by `created_at` in bounded pages and removes
 * matches by id. Returns how many were removed.
 */
export async function sweepExpiredDm17Rumors(
  self: string,
  opts: { signal?: AbortSignal } = {},
): Promise<number> {
  const s = dm17Store(self);
  const now = Math.floor(Date.now() / 1000);
  let until: number | undefined;
  let removed = 0;

  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const filter: { kinds: number[]; limit: number; until?: number } = {
      kinds: DM_RUMOR_KINDS,
      limit: SWEEP_PAGE,
    };
    if (until !== undefined) filter.until = until;
    const events = await s.query([filter], { signal: opts.signal });
    if (events.length === 0) break;

    const ids = events.filter((ev) => isExpired(ev.tags, now)).map((ev) => ev.id);
    if (ids.length > 0) {
      await s.remove([{ ids }], { signal: opts.signal });
      removed += ids.length;
    }
    if (events.length < SWEEP_PAGE) break;
    // Page strictly older than this page's oldest row. Ties on `created_at`
    // would otherwise loop forever on the same boundary second.
    const oldest = Math.min(...events.map((ev) => ev.created_at));
    if (until !== undefined && oldest - 1 >= until) break;
    until = oldest - 1;
  }

  if (removed > 0) emitWireScopes(["dm"]);
  return removed;
}

// ── Sync cursor ───────────────────────────────────────────────────────────────
//
// The inbox scan's resume position, persisted so a cold launch tops up from
// where it left off instead of re-reading the whole `#p` backlog. Wrap
// timestamps are backdated ≤ 2 days (NIP-59), so consumers re-scan a slack
// window behind `newest` — see useDm17's RESYNC_SLACK.

/** The DM inbox's persisted sync position. */
export interface Dm17Cursor {
  /** `created_at` of the newest wrap ingested. */
  newest: number;
  /** `created_at` of the oldest wrap paged back to (the backfill `until`). */
  oldest: number;
  /** No relay had deeper history past `oldest` — stop older-backfills. */
  exhausted: boolean;
}

const cursorKey = (self: string) => `dm17-cursor:${self}`;

/** Read the viewer's inbox cursor, or undefined if none has been saved. */
export function readDm17Cursor(self: string): Promise<Dm17Cursor | undefined> {
  return readFolded<Dm17Cursor>(cursorKey(self));
}

/**
 * Merge sync progress into the cursor (best-effort). `newest` only advances,
 * `oldest` only recedes, `exhausted` is sticky.
 */
export async function updateDm17Cursor(self: string, patch: Partial<Dm17Cursor>): Promise<void> {
  const prev = await readDm17Cursor(self);
  const next: Dm17Cursor = {
    newest: Math.max(prev?.newest ?? 0, patch.newest ?? 0),
    oldest:
      patch.oldest !== undefined
        ? prev?.oldest
          ? Math.min(prev.oldest, patch.oldest)
          : patch.oldest
        : (prev?.oldest ?? 0),
    exhausted: patch.exhausted ?? prev?.exhausted ?? false,
  };
  await writeFolded(cursorKey(self), next);
}

// ── Opened-wrap memo ─────────────────────────────────────────────────────────
//
// Wrap ids the inbox scan has already opened (rumor stored, or judged not
// ours / a foreign rumor kind), persisted per viewer. The scan re-fetches a
// 2-day slack window behind its cursor on every pass (NIP-59 backdating), so
// with only a session-scoped seen set every cold launch re-decrypted up to a
// full inbox page — two NIP-44 opens per wrap — before the UI settled. An
// Android WebView kill makes every resume a cold start, so the memo must be
// durable. Wiped with the rest of the fold cache on logout; a lost or evicted id
// merely re-decrypts once.

const seenWrapsKey = (self: string) => `dm17-seen:${self}`;

/** Cap on persisted opened-wrap ids (callers half-evict at this bound). */
export const DM17_SEEN_CAP = 4096;

/** Read the viewer's persisted opened-wrap ids (insertion order preserved). */
export function readDm17SeenWrapIds(self: string): Promise<string[] | undefined> {
  return readFolded<string[]>(seenWrapsKey(self));
}

/** Persist the viewer's opened-wrap ids (best-effort). */
export async function writeDm17SeenWrapIds(self: string, ids: Iterable<string>): Promise<void> {
  await writeFolded(seenWrapsKey(self), [...ids]);
}

// ── Live inbound-wrap buffer ────────────────────────────────────────────────
//
// The wire's standing kind-1059 subscription RECEIVES a DM gift wrap live, but
// can't decrypt it (that needs the user's signer + the consent gate, owned by
// useDm17). Rather than have useDm17 re-fetch the same wrap from the relays —
// a second round-trip that re-pays NIP-42 auth on gating relays (the ~10-20s
// live-DM latency) — the wire stashes the RAW wrap here and rings `dm:wrap`.
// useDm17 drains and decrypts the in-hand ciphertext directly: no re-query.
//
// The wire's wrap filter deliberately rewinds `since` by the NIP-59 backdate
// window (see stampRoundSince), so every fresh REQ round REPLAYS recent wraps.
// A session-seen id set makes buffering idempotent: a replayed wrap is never
// re-buffered, never re-rings the doorbell, and never re-notifies. Bounded so
// a flood can't grow unboundedly; ciphertext only, never persisted.

/** Cap on buffered live wraps (a burst past this falls back to the poll). */
const LIVE_WRAP_CAP = 256;
/** Cap on remembered wrap ids (oldest halves are shed — the poll dedupes deeper). */
const LIVE_SEEN_CAP = 4096;
const liveWraps = new Map<string, NostrEvent>();
/** Ids ever accepted into the buffer this session (replay dedupe). */
const liveWrapSeen = new Set<string>();

function rememberLiveWrap(id: string): void {
  if (liveWrapSeen.size >= LIVE_SEEN_CAP) {
    // Shed the oldest half (Sets iterate in insertion order).
    let drop = LIVE_SEEN_CAP >> 1;
    for (const old of liveWrapSeen) {
      liveWrapSeen.delete(old);
      if (--drop <= 0) break;
    }
  }
  liveWrapSeen.add(id);
}

/**
 * Stash raw DM gift wraps the wire received live. Returns the wraps actually
 * accepted — ids already seen this session (a replayed round) are skipped, so
 * callers can gate the `dm:wrap` doorbell / notifications on genuinely new
 * arrivals.
 */
export function bufferLiveDmWraps(wraps: NostrEvent[]): NostrEvent[] {
  const fresh: NostrEvent[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const w of wraps) {
    // A wrap whose NIP-40 deadline has already passed is dropped on arrival —
    // never buffered, never decrypted, never allowed to ring the doorbell (and
    // so never able to raise a notification for a message that no longer
    // exists). `openDmWrap` re-checks; this just stops it earlier.
    if (isExpired(w.tags, now)) continue;
    if (liveWrapSeen.has(w.id)) continue;
    if (liveWraps.size >= LIVE_WRAP_CAP) continue;
    rememberLiveWrap(w.id);
    liveWraps.set(w.id, w);
    fresh.push(w);
  }
  return fresh;
}

/**
 * Put drained wraps BACK (a consent-gate decline deferred the decrypt). This
 * bypasses the session-seen skip — the ids were marked seen when first
 * buffered — so the interactive retry / poll backstop can drain them again.
 */
export function rebufferLiveDmWraps(wraps: NostrEvent[]): void {
  for (const w of wraps) {
    if (liveWraps.size >= LIVE_WRAP_CAP && !liveWraps.has(w.id)) continue;
    liveWraps.set(w.id, w);
  }
}

/** Whether any live wraps are currently buffered awaiting a drain. */
export function hasBufferedLiveDmWraps(): boolean {
  return liveWraps.size > 0;
}

/** Take (and clear) the buffered live wraps for decryption by useDm17. */
export function drainLiveDmWraps(): NostrEvent[] {
  if (liveWraps.size === 0) return [];
  const out = [...liveWraps.values()];
  liveWraps.clear();
  return out;
}

/** Reset the buffer AND the session-seen ids (tests only). */
export function resetLiveDmWraps(): void {
  liveWraps.clear();
  liveWrapSeen.clear();
}

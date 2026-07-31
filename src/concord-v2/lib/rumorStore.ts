/**
 * Concord V2 opened-event cache — the decrypted store for every plane.
 *
 * V2 traffic arrives as opaque kind-1059/21059 wraps (CORD-01). We never
 * persist those wraps anywhere: caching ciphertext is wasteful (every cold read
 * would re-run two NIP-44 opens and a Schnorr verify per event) and pollutes the
 * shared `armada-events` store. Instead we decrypt once on ingest and persist
 * the recovered {@link OpenedEvent} here — a rumor carrying its real kind /
 * author / content / tags, plus the few provenance values a plane must be able
 * to FILTER on — so every plane reads back with an ordinary Nostr filter and no
 * decrypt:
 *
 *   chat:     store.query([{ kinds: [9], "#channel": [channelIdHex], limit }])
 *   control:  store.query([{ "#stream": [controlPk1, controlPk2, …] }])
 *
 * Backed by ArmadaDB, ONE TENANT PER COMMUNITY (`c2:<communityIdHex>`) — a
 * separate physical database each, and separate from `armada-events`, so each
 * community's query engine, custom tag index, and NIP-09 deletion semantics stay
 * isolated.
 *
 * The per-community split is a SECURITY boundary, not a performance one. Every
 * read here is a tag query, and a tag is just data a keyholder wrote: the only
 * thing stopping a member of community A from publishing a rumor tagged with a
 * channel id belonging to community B — and having it served into B's timeline —
 * is application-level validation (`checkChannelBinding` on the chat path,
 * {@link writeOpened}'s refusal of any `channel` tag elsewhere). When every
 * community shared one store, a single bug in either check leaked across
 * communities. Now the tenant is chosen by the CALLER, from the community whose
 * keys it already holds, so a forged tag can at worst collide inside the
 * community that forged it. Defense in depth: the checks stay, and the storage
 * boundary means a lapse in them is contained.
 *
 * Community ids are stable — `sha256("concord/community" || owner_xonly ||
 * owner_salt)` (CORD-01 §A.4), with no epoch input — so a rekey or a Refounding
 * rotates stream keys WITHOUT moving the tenant. One database per joined
 * community, not one per epoch.
 *
 * The full signed SEAL is preserved too — the Control Plane re-wraps plaintext
 * seals verbatim across epochs during a compaction (CORD-02 §5 / `rewrapSeal`)
 * — but in ArmadaDB's KV, keyed by rumor id ({@link readStoredSeal}), NOT in
 * the stored rumor. A seal is not part of the rumor its author signed, and
 * serializing one into a tag value rewrites the very bytes the rumor id
 * commits to. It is also bulky and read by exactly one call site, so a
 * separate key is what it should have been: the row stays the rumor, and the
 * seal is fetched when a compaction actually needs it.
 *
 * Deletes ARE deletes: a kind-5 rumor written here triggers the store's NIP-09
 * pass, which physically removes the targeted event it authored. Moderator
 * deletes are authorized against the roster at the WRITE site (see `useChannel2`)
 * before the kind-5 rumor reaches the store.
 *
 * Trust note: this persists DECRYPTED plane data at rest — the same device-trust
 * level as the folded cache and the signer's decrypt cache, which already do.
 * Anyone with local storage access already holds the keys. Wiped on logout (see
 * purgeClientStorage).
 */

import type { NostrEvent } from "@nostrify/nostrify";

import { readFolded, writeFolded } from "@/lib/foldedCache";
import { KIND_SEAL_PLAINTEXT, KIND_WEBXDC } from "@/concord-v2/lib/kinds";
import { resolveMs, type OpenedEvent } from "@/concord-v2/lib/stream";
import { messageMatchesMedia, type SearchMedia2 } from "@/concord-v2/lib/search";
import { emitWireScopes } from "@/wire/bus";
import { ARMADA_TENANTS, getArmadaDB } from "@/lib/db/armadaDB";
import type { NRumorStore } from "@/lib/db/types";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { OpenedChat } from "@/concord-v2/lib/chat";

/** The legacy single-database store, kept only as the migration's source. */
export const LEGACY_RUMOR_DB_NAME = "armada-concord-rumors";

/** Provenance tags we inject onto the stored event (never part of the rumor). */
const TAG_STREAM = "stream";
const TAG_SEAL = "seal";
const TAG_WRAP = "wrap";
const TAG_SEALKIND = "sealkind";

/** The chat plane's channel binding (CORD-03 §3) — the tag chat reads index. */
const TAG_CHANNEL = "channel";

/**
 * The opened-event store for one community.
 *
 * `defaultIndexTags` indexes every tag with a short name and a value under 200
 * chars, which covers the multi-letter names the planes query (`channel`,
 * `stream`) as well as the single-letter ones (`e`, `p`, `i`, `k`, `q`). The
 * bulky {@link TAG_SEAL} blob is excluded by the value-length cap — a signed
 * seal's JSON is always far past it.
 */
function rumorStore(communityIdHex: string): NRumorStore {
  return getArmadaDB().tenant(communityTenant(communityIdHex));
}

/** The ArmadaDB tenant id holding a community's opened events. */
export function communityTenant(communityIdHex: string): string {
  return `c2:${communityIdHex}`;
}


// ── Codec: OpenedEvent ⇆ stored event ─────────────────────────────────────────
//
// The stored event IS the recovered rumor (its `id` is the rumor id, the NIP-01
// hash), `pubkey` the REAL author (so NIP-09 self-delete matches), and no `sig`.
// Plane provenance rides synthetic tags: `stream` (the wrap author / stream
// address — how non-chat planes query), `wrap`, and `sealkind`. These are
// stripped on read so the reconstructed OpenedEvent's `tags` are byte-identical
// to the rumor's.
//
// Only values that must be FILTERED on (`stream`) or read synchronously off a
// store row (`wrap`, `sealkind` — the fold, the guestbook and the dissolution
// check all branch on them per row) are injected here. The seal, which needs
// neither, lives in KV instead; see {@link readStoredSeal}. `seal` stays in
// {@link PROVENANCE} so rows written before that move — including everything
// copied verbatim out of the legacy database — still strip it on read.

/** Synthetic provenance tag names, stripped when reconstructing the rumor. */
const PROVENANCE = new Set([TAG_STREAM, TAG_SEAL, TAG_WRAP, TAG_SEALKIND]);

/** Build the stored event for an opened stream event (any plane). */
export function openedToStored(opened: OpenedEvent): NostrRumor {
  const tags: string[][] = [
    ...opened.tags,
    [TAG_STREAM, opened.streamPk],
    [TAG_WRAP, opened.wrapId],
    [TAG_SEALKIND, String(opened.sealKind)],
  ];
  return {
    id: opened.rumorId,
    kind: opened.kind,
    content: opened.content,
    tags,
    created_at: opened.createdAt,
    pubkey: opened.author,
  };
}

/** Reconstruct an OpenedEvent from a stored event. */
export function storedToOpened(ev: NostrRumor): OpenedEvent {
  const tags = ev.tags.filter((t) => !PROVENANCE.has(t[0]));
  const streamPk = ev.tags.find((t) => t[0] === TAG_STREAM)?.[1] ?? "";
  const wrapId = ev.tags.find((t) => t[0] === TAG_WRAP)?.[1] ?? "";
  const sealKind = Number(ev.tags.find((t) => t[0] === TAG_SEALKIND)?.[1] ?? "0");

  // Rows written before the seal moved to KV still carry it as a tag; keep
  // reading those so a compaction on an un-rewritten store still finds them.
  // The blob is bulky and needed ONLY by the control-plane rekey path
  // (rewrapSeal), NEVER to render a chat message, so the parse stays behind a
  // lazy memoized getter — eagerly parsing it cost a JSON.parse per message in
  // the window on every channel read (a real switch-latency tax on Android).
  // Rows written since carry no tag and read back `undefined`; the seal comes
  // from {@link readStoredSeal}.
  const sealRaw = ev.tags.find((t) => t[0] === TAG_SEAL)?.[1];
  let sealParsed: NostrEvent | undefined;

  return {
    rumorId: ev.id,
    author: ev.pubkey,
    kind: ev.kind,
    content: ev.content,
    tags,
    ms: resolveMs(ev.created_at, tags),
    createdAt: ev.created_at,
    wrapId,
    streamPk,
    sealKind,
    get seal(): NostrEvent | undefined {
      if (sealRaw === undefined) return undefined;
      if (sealParsed === undefined) {
        try {
          sealParsed = JSON.parse(sealRaw) as NostrEvent;
        } catch {
          return undefined;
        }
      }
      return sealParsed;
    },
  };
}

/** Reconstruct an OpenedChat (adds channel/epoch from the rumor's binding tags). */
export function storedToOpenedChat(ev: NostrRumor, channelIdHex: string): OpenedChat {
  const opened = storedToOpened(ev);
  const epochTag = opened.tags.find((t) => t[0] === "epoch")?.[1];
  return { ...opened, channelIdHex, epoch: epochTag ? BigInt(epochTag) : 0n };
}

// ── Reads / writes ────────────────────────────────────────────────────────────

/** All chat-plane rumor kinds we persist and fold. */
const CHAT_KINDS = [5, 7, 9, 1018, 1068, 1111, 3302, 8333, 9735, 31922, 31923, 31925];

/**
 * Read a channel's cached chat rumors, newest-first up to `limit`. A `channel`
 * tag query hits the tag index directly. `before` (a `created_at` upper bound,
 * exclusive) pages older history out of the store.
 */
export async function queryChannelRumors(
  communityIdHex: string,
  channelIdHex: string,
  opts: { limit: number; before?: number; signal?: AbortSignal },
): Promise<OpenedChat[]> {
  const filter: { kinds: number[]; "#channel": string[]; limit: number; until?: number } = {
    kinds: CHAT_KINDS,
    "#channel": [channelIdHex],
    limit: opts.limit,
  };
  if (opts.before !== undefined) filter.until = opts.before - 1;
  const events = await rumorStore(communityIdHex).query([filter], { signal: opts.signal });
  return events.map((ev) => storedToOpenedChat(ev, channelIdHex));
}

/**
 * Read a channel's cached WebXDC coordination rumors (kind {@link KIND_WEBXDC})
 * for one app session (`#i` = the webxdc uuid). Deliberately SEPARATE from
 * {@link queryChannelRumors}: 3310 is not in {@link CHAT_KINDS}, so these
 * durable in-chat-app state updates are stored (the wire decrypts every inner
 * kind) but never surface in the timeline. Both `channel` and the single-letter
 * `i` are index-backed, so this is a cheap indexed read. Durable state only —
 * realtime frames ride ephemeral 21059 wraps and are never stored.
 */
export async function queryWebxdcRumors(
  communityIdHex: string,
  channelIdHex: string,
  uuid: string,
  opts?: { signal?: AbortSignal },
): Promise<OpenedChat[]> {
  if (!channelIdHex || !uuid) return [];
  const events = await rumorStore(communityIdHex).query(
    [{ kinds: [KIND_WEBXDC], "#channel": [channelIdHex], "#i": [uuid], limit: 1000 }],
    { signal: opts?.signal },
  );
  return events.map((ev) => storedToOpenedChat(ev, channelIdHex));
}

/**
 * Read the newest `perChannel` chat rumors for EACH of several channels in a
 * SINGLE store transaction, returned grouped by channel id.
 *
 * The store's `query([...])` runs every filter concurrently inside one
 * readonly transaction, so passing one `#channel` filter per channel collapses
 * what used to be N independent `queryChannelRumors` calls (N transactions, N
 * connection acquisitions — the source of the channel-switch contention) into a
 * single transaction. Each filter is independently `limit`-bounded, so a busy
 * channel can't starve a quiet one (unlike a single multi-value `#channel`
 * filter, whose global limit is shared across channels).
 *
 * Channels with no cached rumors are omitted from the result map.
 */
export async function queryRumorsByChannel(
  communityIdHex: string,
  channelIdsHex: string[],
  opts: { perChannel: number; signal?: AbortSignal },
): Promise<Map<string, OpenedChat[]>> {
  const out = new Map<string, OpenedChat[]>();
  if (channelIdsHex.length === 0) return out;

  const events = await rumorStore(communityIdHex).query(
    channelIdsHex.map((idHex) => ({
      kinds: CHAT_KINDS,
      "#channel": [idHex],
      limit: opts.perChannel,
    })),
    { signal: opts.signal },
  );

  // One query() merges + de-dupes across filters, so recover each row's channel
  // from its own binding tag rather than trusting filter order.
  for (const ev of events) {
    const idHex = ev.tags.find((t) => t[0] === "channel")?.[1];
    if (!idHex) continue;
    let list = out.get(idHex);
    if (!list) out.set(idHex, (list = []));
    list.push(storedToOpenedChat(ev, idHex));
  }
  return out;
}

/**
 * Read cached messages across a community's channels that p-tag `pubkey` — the
 * "@ Mentions" view, purely local (no relay, no decrypt). Both `p` and
 * `channel` are in {@link QUERYABLE_TAGS}, so the filter is index-backed. Each
 * message's own `channel` binding tag recovers its channel id for the row.
 * Covers kind-9 messages and kind-1111 thread replies (a reply p-tags the
 * message author, so "replied to you" surfaces here too).
 *
 * Deliberately NOT derived from {@link queryRumorsByChannel}: that scan reads
 * only the newest window of each channel, so a mention older than a busy
 * channel's window would silently vanish from the tab. This single indexed
 * filter reaches the newest `limit` mentions across the WHOLE store, however
 * deep, in one cheap transaction.
 */
export async function queryMentionRumors(
  communityIdHex: string,
  channelIdsHex: string[],
  pubkey: string,
  opts: { limit: number; signal?: AbortSignal },
): Promise<OpenedChat[]> {
  if (channelIdsHex.length === 0 || !pubkey) return [];
  const filter = {
    kinds: [9, 1111],
    "#p": [pubkey],
    "#channel": channelIdsHex,
    limit: opts.limit,
  };
  const events = await rumorStore(communityIdHex).query([filter], { signal: opts.signal });
  return events.map((ev) =>
    storedToOpenedChat(ev, ev.tags.find((t) => t[0] === "channel")?.[1] ?? ""),
  );
}

/** Message kinds whose content is user-searchable: chat + NIP-22 thread comments. */
const SEARCHABLE_KINDS = [9, 1068, 1111];

/**
 * Upper bound on rumors scanned per search. The store has NO content index
 * (only tags are indexed), so a content/media search is a scan of the cached
 * messages — this caps the newest-first scan so a very deep community can't
 * stall the search. `#channel` and `authors` ARE index-backed, so those
 * facets narrow the scan cheaply before the in-memory predicates run.
 */
const SEARCH_SCAN_LIMIT = 5000;

/**
 * Search cached message rumors across one or more channels, newest-first up to
 * `limit`. Purely local: V2 chat is end-to-end encrypted, so — unlike NIP-29's
 * relay NIP-50 search — the decrypted rumor store is the ONLY searchable
 * corpus. The `#channel` allow-list and `authors` are pushed into the indexed
 * store filter; the free-text `query` (case-insensitive substring) and `media`
 * facet are applied in memory over the scan. Each result recovers its own
 * channel id from its `channel` binding tag.
 */
export async function searchRumors(
  communityIdHex: string,
  channelIdsHex: string[],
  opts: {
    query: string;
    authors?: string[];
    media?: SearchMedia2;
    limit: number;
    signal?: AbortSignal;
  },
): Promise<OpenedChat[]> {
  if (channelIdsHex.length === 0) return [];
  const filter: {
    kinds: number[];
    "#channel": string[];
    authors?: string[];
    limit: number;
  } = { kinds: SEARCHABLE_KINDS, "#channel": channelIdsHex, limit: SEARCH_SCAN_LIMIT };
  if (opts.authors && opts.authors.length > 0) filter.authors = opts.authors;

  const events = await rumorStore(communityIdHex).query([filter], { signal: opts.signal });
  const q = opts.query.trim().toLowerCase();
  const media = opts.media ?? "all";

  // `query` returns newest-first, so iterate and stop at `limit` for the newest
  // matches across the whole scanned window.
  const out: OpenedChat[] = [];
  for (const ev of events) {
    if (q && !ev.content.toLowerCase().includes(q)) continue;
    if (!messageMatchesMedia(ev.content, ev.tags, media)) continue;
    const idHex = ev.tags.find((t) => t[0] === "channel")?.[1] ?? "";
    out.push(storedToOpenedChat(ev, idHex));
    if (out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Read every cached opened event published to one of `streamPks` (a plane's
 * stream addresses across held epochs). Used by the control / guestbook / rekey
 * planes, which query by stream address rather than by channel tag.
 */
export async function queryByStreams(
  communityIdHex: string,
  streamPks: string[],
  opts?: { limit?: number; signal?: AbortSignal },
): Promise<OpenedEvent[]> {
  if (streamPks.length === 0) return [];
  const filter: { "#stream": string[]; limit?: number } = { "#stream": streamPks };
  if (opts?.limit !== undefined) filter.limit = opts.limit;
  const events = await rumorStore(communityIdHex).query([filter], { signal: opts?.signal });
  return events.map(storedToOpened);
}

/**
 * True if the rumor carries a tag name the store synthesizes for itself. The
 * rumor's own tags are spread FIRST in {@link openedToStored}, so a forged
 * `stream` would both land in the index and win `storedToOpened`'s `find` —
 * letting any keyholder on any plane publish a rumor that reads back as
 * belonging to a stream address they hold no key for. No legitimate rumor on
 * any plane sets these names.
 */
function forgesProvenance(opened: OpenedEvent): boolean {
  return opened.tags.some((t) => PROVENANCE.has(t[0]));
}

// ── Seals ─────────────────────────────────────────────────────────────────────
//
// A seal is the author-signed NIP-59 envelope the rumor arrived in — evidence
// ABOUT the rumor, not part of it. It is kept only so a Refounding's compaction
// can republish an entity's head under the new epoch verbatim (CORD-06 §3), and
// is read by exactly one call site, once per rotation.

/** KV key holding the signed seal a stored rumor arrived in. */
function sealKey(communityIdHex: string, rumorId: string): string {
  return `c2seal:${communityIdHex}:${rumorId}`;
}

/**
 * The seal a stored rumor arrived in, or undefined if none was kept.
 *
 * Only PLAINTEXT seals are kept: `rewrapSeal` refuses an encrypted one (its
 * ciphertext is bound to the old stream's conversation key, so it cannot
 * survive a re-wrap), which makes storing them pure cost — and encrypted is
 * what chat, guestbook and rekey all use, i.e. nearly every rumor in the store.
 *
 * Prefer a seal already on the {@link OpenedEvent}: an event opened this
 * session carries the real one, and a row predating the KV move carries it as a
 * tag. This is the fallback for everything else.
 */
export async function readStoredSeal(
  communityIdHex: string,
  rumorId: string,
): Promise<NostrEvent | undefined> {
  if (!communityIdHex || !rumorId) return undefined;
  try {
    return await getArmadaDB().kv.get<NostrEvent>(sealKey(communityIdHex, rumorId));
  } catch {
    return undefined;
  }
}

/** Store a batch verbatim in a community's tenant. Best-effort: failures are swallowed. */
function writeStored(communityIdHex: string, opened: OpenedEvent[]): Promise<void> {
  if (opened.length === 0 || !communityIdHex) return Promise.resolve();
  const db = getArmadaDB();
  const s = db.tenant(communityTenant(communityIdHex));
  return Promise.all(
    opened.flatMap((o) => {
      const write = s.event(openedToStored(o));
      const seal = o.seal;
      return seal && o.sealKind === KIND_SEAL_PLAINTEXT
        ? [write, db.kv.set(sealKey(communityIdHex, o.rumorId), seal)]
        : [write];
    }),
  )
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Persist opened stream events (any plane EXCEPT chat — see {@link writeRumors}).
 * Kind-5 deletes trigger the store's self-only NIP-09 removal of their targets.
 * Best-effort: failures are swallowed. Resolves once the batched write commits,
 * so callers that need to act on the durable result (e.g. ring the bus) can
 * await it; most fire and forget.
 *
 * Rejects any rumor carrying a `channel` tag. Only chat/typing/voice rumors
 * bind a channel, and only `checkChannelBinding` — which the chat decode path
 * runs before this store ever sees them — proves that binding matches the key
 * that decrypted the wrap. The plane openers (`openPlaneWraps`) enforce no such
 * binding and apply no kind filter, so without this a holder of a community's
 * control / guestbook / rekey key could wrap a chat-kind rumor tagged with ANY
 * channel id, and it would be indexed under `#channel` and served by
 * {@link queryChannelRumors} into that channel's timeline — including a private
 * channel, or a channel in another community, whose stream key they do not
 * hold. Reject rather than strip, so stored tags stay byte-identical to the
 * rumor's.
 */
export function writeOpened(communityIdHex: string, opened: OpenedEvent[]): Promise<void> {
  return writeStored(
    communityIdHex,
    opened.filter((o) => !forgesProvenance(o) && !o.tags.some((t) => t[0] === TAG_CHANNEL)),
  );
}

/**
 * Persist opened chat rumors, then ring the wire bus for each channel written
 * so every live timeline (and the community scan) re-reads — regardless of
 * which query kicked off the write. This is what makes the write→paint path
 * event-driven: a backfill that decrypted a cold channel's history announces
 * `c2:<channel>` once its rumors are durably stored, so the timeline paints
 * even if the query that started the backfill was superseded or aborted first.
 *
 * The emit is deferred until the write commits, so the re-read it triggers sees
 * the just-written rows.
 */
export function writeRumors(communityIdHex: string, opened: OpenedChat[]): void {
  // The `channel` binding rides through: the chat decode path already proved it
  // equals the coordinate whose key opened the wrap (`checkChannelBinding`).
  // Forged provenance still can't.
  const safe = opened.filter((o) => !forgesProvenance(o));
  if (safe.length === 0) return;
  const channels = new Set(safe.map((o) => o.channelIdHex).filter(Boolean));
  void writeStored(communityIdHex, safe).then(() => {
    if (channels.size > 0) emitWireScopes([...channels].map((id) => `c2:${id}`));
  });
}

// ── Pending raw-wrap holding store ──────────────────────────────────────────
//
// The native background service (Android/iOS) receives V2 wraps but can't
// decrypt them — it has no stream keys. It parks the raw kind-1059/21059 wraps
// here (a SEPARATE tiny tenant) instead of the shared event cache; the
// WebView's plane hooks — which DO hold the keys — read them with
// {@link peekPendingWraps}, decrypt, and acknowledge ONLY the wraps that
// actually decoded with {@link ackPendingWraps}. A wrap is never deleted
// before its rumor is safely in the opened-event store: an aborted or failed
// decrypt round leaves it parked for the next read (a notified message must
// never be locally destructible — issue #19). Undecodable stragglers (e.g. a
// key never arrives) are pruned by age. So no 1059 ever lands in the `main`
// tenant, yet a notification's message survives a cold launch. Wraps
// are indexed only by their author (the stream address) so a plane can read
// exactly its own.
//
// Lives in its own ArmadaDB tenant. Wraps are stored WITHOUT their signature:
// a wrap is signed by a throwaway ephemeral key, `openWrap` never checks that
// signature, and everything authenticating the message is the seal sealed
// inside it — so there is nothing here to preserve.

const PENDING_TENANT = ARMADA_TENANTS.c2Park;

/** Parked wraps older than this are pruned (key never arrived / dead plane). */
const PENDING_MAX_AGE_SECS = 14 * 24 * 3600;

function pendingStore(): NRumorStore {
  // Queried by `authors` (the wrap's stream pubkey) only, so no tag index
  // matters here.
  return getArmadaDB().tenant(PENDING_TENANT);
}

/**
 * Whether the pending store is known to hold nothing peek-worthy:
 *   - `true`      — provably empty; peeks return without touching IndexedDB.
 *   - `false`     — something is (or may be) parked; peeks do the real read.
 *   - `undefined` — unknown (fresh session); the FIRST peek probes the durable
 *                   store once and caches the answer.
 *
 * The probe is what keeps this correct across restarts: wraps parked in a
 * PREVIOUS session (key never arrived before the app was killed) are durable,
 * so a session-scoped "was anything parked?" flag alone would hide them from
 * the drain forever — the native service's buffer was already drained, so
 * nothing re-parks them. One cheap `limit: 1` probe on the first peek finds
 * them; after that, the common web/desktop case (nothing ever parked) skips
 * IndexedDB on every subsequent peek, keeping the parked-wrap drain off the
 * channel-read hot path.
 */
let pendingKnownEmpty: boolean | undefined;

/** How often (ms) to run the age-prune of undecodable stragglers. */
const PENDING_PRUNE_INTERVAL_MS = 5 * 60_000;
let lastPendingPruneAt = 0;

/** Park raw V2 wraps for later WebView-side decryption (native ingest path). */
export function parkPendingWraps(wraps: NostrEvent[]): void {
  if (wraps.length === 0) return;
  pendingKnownEmpty = false;
  const s = pendingStore();
  void Promise.all(
    wraps.map(({ sig: _sig, ...wrap }) => s.event(wrap)),
  ).catch(() => undefined);
}

/**
 * Read (WITHOUT removing) the raw wraps parked for a plane's stream addresses.
 * The caller decrypts them, writes the recovered rumors to the opened-event
 * store, and then acknowledges the decoded ones via {@link ackPendingWraps}.
 *
 * Returns immediately when the pending store is known empty (see {@link
 * pendingKnownEmpty}). Otherwise reads the parked wraps, and — at most once
 * every {@link PENDING_PRUNE_INTERVAL_MS} — age-prunes permanently-undecodable
 * stragglers (a readwrite scan kept off the per-peek path).
 */
export async function peekPendingWraps(streamPks: string[]): Promise<NostrRumor[]> {
  if (streamPks.length === 0) return [];
  if (pendingKnownEmpty === true) return [];
  const s = pendingStore();
  try {
    if (pendingKnownEmpty === undefined) {
      // First peek this session: one cheap probe of the durable store, so
      // wraps parked in a previous session are still found (see above).
      const any = await s.query([{ kinds: [1059, 21059], limit: 1 }]);
      // A concurrent park may have flipped this to `false` mid-probe; an empty
      // probe result must not clobber that.
      if (pendingKnownEmpty === undefined) pendingKnownEmpty = any.length === 0;
      if (pendingKnownEmpty === true) return [];
    }
    const now = Date.now();
    if (now - lastPendingPruneAt >= PENDING_PRUNE_INTERVAL_MS) {
      lastPendingPruneAt = now;
      const cutoff = Math.floor(now / 1000) - PENDING_MAX_AGE_SECS;
      void s.remove([{ kinds: [1059, 21059], until: cutoff }]).catch(() => undefined);
    }
    return await s.query([{ kinds: [1059, 21059], authors: streamPks, limit: 1000 }]);
  } catch {
    return [];
  }
}

/** Remove parked wraps whose rumors are now safely in the opened-event store. */
export function ackPendingWraps(wrapIds: string[]): void {
  if (wrapIds.length === 0) return;
  const s = pendingStore();
  void s.remove([{ ids: wrapIds }]).catch(() => undefined);
}

// ── Sync cursor ───────────────────────────────────────────────────────────────
//
// Per-stream resume state, persisted in the folded IndexedDB cache so a cold
// launch resumes sync instead of refetching everything it has already seen. Kept
// tiny (three numbers per key). Keyed by an opaque scope string: a channel id
// (chat) or a community id + plane name (control/guestbook/rekey).

/** A stream's persisted sync position. */
export interface StreamCursor {
  /** `created_at` of the newest wrap ingested (the live-sub / refetch `since` floor). */
  newest: number;
  /** `created_at` of the oldest wrap paged back to (the backfill `until`). */
  oldest: number;
  /** No relay had deeper history past `oldest` — stop issuing older-backfills. */
  exhausted: boolean;
}

const cursorKey = (scope: string) => `concord2-cursor:${scope}`;

/** Read a scope's sync cursor, or undefined if none has been saved yet. */
export function readStreamCursor(scope: string): Promise<StreamCursor | undefined> {
  return readFolded<StreamCursor>(cursorKey(scope));
}

/**
 * Merge new sync progress into a scope's cursor (best-effort). `newest` only
 * advances forward, `oldest` only recedes, `exhausted` is sticky until cleared.
 */
export async function updateStreamCursor(scope: string, patch: Partial<StreamCursor>): Promise<void> {
  const prev = await readStreamCursor(scope);
  const next: StreamCursor = {
    newest: Math.max(prev?.newest ?? 0, patch.newest ?? 0),
    oldest:
      patch.oldest !== undefined
        ? prev?.oldest
          ? Math.min(prev.oldest, patch.oldest)
          : patch.oldest
        : (prev?.oldest ?? 0),
    exhausted: patch.exhausted ?? prev?.exhausted ?? false,
  };
  await writeFolded(cursorKey(scope), next);
}

/** Clear the exhausted flag (e.g. after a rekey catch-up unlocks older history). */
export async function clearStreamExhausted(scope: string): Promise<void> {
  const prev = await readStreamCursor(scope);
  if (prev?.exhausted) await writeFolded(cursorKey(scope), { ...prev, exhausted: false });
}

// Back-compat aliases (chat call sites).
export const readChannelCursor = readStreamCursor;
export const updateChannelCursor = updateStreamCursor;
export const clearChannelExhausted = clearStreamExhausted;

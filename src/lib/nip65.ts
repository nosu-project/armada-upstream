import { normalizeRelayUrl } from "@/lib/platform";
import { verifyEventOnce, verifyEventsOnce } from "@/lib/verifyCache";
import { ecVerifyBatch } from "@/lib/verifyPool";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** NIP-65 relay-list metadata event kind. */
export const KIND_RELAY_LIST = 10002;

/**
 * A signed relay list controls live sockets, fan-out and background work. Keep
 * a malformed or unexpectedly huge list from turning one login into an
 * unbounded connection storm. NIP-65 recommends only 2-4 relays per category;
 * sixteen still leaves ample room for overlap and migrations.
 */
export const MAX_RELAY_LIST_RELAYS = 16;

export interface RelayPreference {
  url: string;
  read: boolean;
  write: boolean;
}

interface RelayQueryClient {
  relay(url: string): {
    query(
      filters: NostrFilter[],
      opts: { signal: AbortSignal },
    ): Promise<NostrEvent[]>;
  };
  /**
   * Pool-wide read, used only as a fallback when no explicit relays are given
   * (see `queryExplicitRelays`). Optional so test doubles need not provide it.
   */
  query?(
    filters: NostrFilter[],
    opts: { signal: AbortSignal },
  ): Promise<NostrEvent[]>;
}

export interface ExplicitRelayQueryResult {
  events: NostrEvent[];
  /** Explicit relay URLs whose query reached EOSE successfully. */
  answered: string[];
  failed: string[];
}

export interface ExplicitQueryOptions {
  /**
   * Once the FIRST relay settles, wait at most this long for the rest before
   * resolving with whatever has answered. A relay still in flight when the
   * window closes is reported as neither `answered` nor `failed` — its socket
   * keeps running under `signal`, it simply stops holding the read open. Omit
   * to wait for every relay (bounded only by `signal`, the pre-existing
   * behavior).
   *
   * The login sync gate passes this so one dead relay in a fan-out (a
   * `wss://…` that never upgrades) can't hold a phase's "establishing …" line
   * spinning for the full step timeout after every reachable relay has already
   * answered. Leaving a laggard OUT of `failed` rather than in it keeps the
   * conservative direction for list writes: absence stays non-authoritative
   * (we did not hear from that relay) instead of looking like a hard failure.
   */
  graceMs?: number;
}

type SettleState<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected" }
  | { status: "pending" };

/**
 * Like `Promise.allSettled`, but if `graceMs` is given the whole batch resolves
 * once the first promise settles plus `graceMs` — promises still outstanding
 * then are left `pending` (and never rejected on our behalf; their own
 * rejection is swallowed so nothing dangles).
 */
async function settleWithGrace<T>(
  promises: Promise<T>[],
  graceMs: number | undefined,
): Promise<SettleState<T>[]> {
  const states: SettleState<T>[] = promises.map(() => ({ status: "pending" }));
  const tracked = promises.map((promise, index) =>
    promise.then(
      (value) => {
        states[index] = { status: "fulfilled", value };
      },
      () => {
        states[index] = { status: "rejected" };
      },
    ),
  );
  if (!graceMs || tracked.length === 0) {
    await Promise.all(tracked);
    return states;
  }
  await new Promise<void>((resolve) => {
    let settled = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve();
    };
    for (const track of tracked) {
      void track.then(() => {
        settled += 1;
        if (settled === tracked.length) {
          finish();
          return;
        }
        // Start the grace clock on the first response, not on construction.
        if (graceTimer === undefined) graceTimer = setTimeout(finish, graceMs);
      });
    }
  });
  return states;
}

interface RelayPublishClient {
  relay(url: string): {
    event(event: NostrEvent, opts: { signal: AbortSignal }): Promise<unknown>;
  };
}

export interface RelayListPublishResult {
  accepted: string[];
  rejected: string[];
}

export interface RelayListDiscovery {
  event: NostrEvent;
  relays: RelayPreference[];
}

export interface RelayListDiscoveryRead extends ExplicitRelayQueryResult {
  discovery?: RelayListDiscovery;
}

/** NIP-01 ordering for a live replaceable-event stream. */
export function relayListVersionIsNewer(
  candidate: Pick<NostrEvent, "created_at" | "id">,
  current: Pick<NostrEvent, "created_at" | "id"> | undefined,
): boolean {
  return !current
    || candidate.created_at > current.created_at
    || (candidate.created_at === current.created_at && candidate.id < current.id);
}

/**
 * Compare a kind-10002 candidate with its persisted metadata mirror. Legacy
 * mirrors have only a timestamp; at an equal second they accept the first
 * aggregate-discovered winner once, stamp its id, and are deterministic from
 * then on.
 */
export function relayListIsNewerThanMetadata(
  candidate: Pick<NostrEvent, "created_at" | "id">,
  current: { updatedAt: number; eventId?: string },
): boolean {
  if (candidate.created_at !== current.updatedAt) {
    return candidate.created_at > current.updatedAt;
  }
  return current.eventId === undefined || candidate.id < current.eventId;
}

/**
 * Parse and normalize a kind-10002 event. Bare `r` tags are read+write;
 * duplicate read/write tags for one URL are merged instead of first-wins.
 */
export function parseRelayList(event: Pick<NostrEvent, "tags">): RelayPreference[] {
  const byUrl = new Map<string, RelayPreference>();

  for (const tag of event.tags) {
    if (tag[0] !== "r" || !tag[1]) continue;
    const url = normalizeRelayUrl(tag[1]);
    if (!url) continue;

    const marker = tag[2];
    if (marker && marker !== "read" && marker !== "write") continue;

    let relay = byUrl.get(url);
    if (!relay) {
      if (byUrl.size >= MAX_RELAY_LIST_RELAYS) continue;
      relay = { url, read: false, write: false };
      byUrl.set(url, relay);
    }

    if (!marker) {
      relay.read = true;
      relay.write = true;
    } else if (marker === "read") {
      relay.read = true;
    } else {
      relay.write = true;
    }
  }

  return [...byUrl.values()].filter((relay) => relay.read || relay.write);
}

/** Build canonical NIP-65 `r` tags from relay preferences. */
export function buildRelayListTags(relays: RelayPreference[]): string[][] {
  const normalized = parseRelayList({
    tags: relays.flatMap((relay) => {
      if (relay.read && relay.write) return [["r", relay.url]];
      if (relay.read) return [["r", relay.url, "read"]];
      if (relay.write) return [["r", relay.url, "write"]];
      return [];
    }),
  });

  return normalized.map((relay) => {
    if (relay.read && relay.write) return ["r", relay.url];
    return ["r", relay.url, relay.read ? "read" : "write"];
  });
}

/**
 * Batch-verify a relay result set OFF the main thread, deduped by id, and drop
 * the copies that fail. A cold community/DM switch resolves several of these
 * lists at once (follow, mute, groups, DM relays, portable setup), each a
 * first-seen batch, and verifying them one synchronous Schnorr at a time on
 * this thread profiled at ~950ms of a switch — a single frozen frame. This
 * routes the EC through the worker pool (`verifyPool`) via the same memoized
 * batch verifier the relay inbox uses, so a duplicate — or a later
 * {@link newestRelayList} over the same events — pays no EC at all.
 */
async function verifyRelayEvents(events: NostrEvent[]): Promise<NostrEvent[]> {
  if (events.length === 0) return [];
  const verdicts = await verifyEventsOnce(events, ecVerifyBatch);
  return events.filter((_, index) => verdicts[index]);
}

/**
 * Newest replaceable event: highest timestamp, then lowest id on a tie.
 *
 * Verifies through the memo (`verifyEventOnce`): its inputs have usually
 * already passed {@link verifyRelayEvents}, so this is a memo hit with no EC —
 * and the single-candidate path (`newerRelayListUpdate`) still pays exactly one
 * Schnorr verify.
 */
export function newestRelayList(events: NostrEvent[]): NostrEvent | undefined {
  return events
    .filter((event) => event.kind === KIND_RELAY_LIST && verifyEventOnce(event))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

/** Validate and order one candidate from a standing kind-10002 stream. */
export function newerRelayListUpdate(
  candidate: NostrEvent,
  current: NostrEvent | undefined,
): RelayListDiscovery | undefined {
  const event = newestRelayList([candidate]);
  if (!event) return undefined;
  if (
    current?.pubkey === event.pubkey
    && !relayListVersionIsNewer(event, current)
  ) return undefined;
  const relays = parseRelayList(event);
  return relays.length > 0 ? { event, relays } : undefined;
}

/** Normalize and dedupe relay URLs while preserving their first-seen order. */
export function uniqueRelayUrls(relays: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of relays) {
    const url = normalizeRelayUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Query explicit relays independently and combine their valid events. One
 * offline indexer cannot suppress a result already returned by another.
 */
export async function queryExplicitRelays(
  nostr: RelayQueryClient,
  relayUrls: Iterable<string>,
  filters: NostrFilter[],
  signal: AbortSignal,
  opts?: ExplicitQueryOptions,
): Promise<NostrEvent[]> {
  return (await queryExplicitRelaysWithStatus(nostr, relayUrls, filters, signal, opts)).events;
}

/** The status-bearing form used when an empty successful read matters. */
export async function queryExplicitRelaysWithStatus(
  nostr: RelayQueryClient,
  relayUrls: Iterable<string>,
  filters: NostrFilter[],
  signal: AbortSignal,
  opts?: ExplicitQueryOptions,
): Promise<ExplicitRelayQueryResult> {
  const urls = uniqueRelayUrls(relayUrls);
  // No explicit relays to scope to — e.g. the app relays are switched off and
  // no NIP-65 write relays have been adopted. Reading nothing would silently
  // drop account-data singletons that the general pool can still reach, so fall
  // back to a pool-wide read (the pre-scoping behavior) rather than return [].
  if (urls.length === 0) {
    if (!nostr.query) return { events: [], answered: [], failed: [] };
    try {
      const events = await nostr.query(filters, { signal });
      return { events: await verifyRelayEvents(events), answered: [], failed: [] };
    } catch {
      return { events: [], answered: [], failed: [] };
    }
  }
  const settled = await settleWithGrace(
    urls.map((url) => nostr.relay(url).query(filters, { signal })),
    opts?.graceMs,
  );
  const all: NostrEvent[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") all.push(...result.value);
  }
  // Read the settle states with the events they came with, BEFORE the verify is
  // awaited. `settleWithGrace` keeps writing into `settled` as laggards land,
  // and the await below is not free of macrotasks — the inline verify yields
  // every 5ms and a pool round is longer still. Read after it, a relay that
  // answered inside that window would be reported as having answered while the
  // events it returned were already left out of `all`; that pair is exactly
  // what a list write reads as an authoritative empty read.
  const answered = urls.filter((_, index) => settled[index]?.status === "fulfilled");
  const failed = urls.filter((_, index) => settled[index]?.status === "rejected");
  const byId = new Map<string, NostrEvent>();
  for (const event of await verifyRelayEvents(all)) byId.set(event.id, event);
  return { events: [...byId.values()], answered, failed };
}

/** Find a user's newest signed NIP-65 list on a bounded discovery set. */
export async function discoverRelayList(
  nostr: RelayQueryClient,
  pubkey: string,
  relayUrls: Iterable<string>,
  signal: AbortSignal,
  opts?: ExplicitQueryOptions,
): Promise<RelayListDiscovery | undefined> {
  return (await discoverRelayListWithStatus(
    nostr,
    pubkey,
    relayUrls,
    signal,
    opts,
  )).discovery;
}

/** Discovery plus EOSE status, for writes that must distinguish empty from offline. */
export async function discoverRelayListWithStatus(
  nostr: RelayQueryClient,
  pubkey: string,
  relayUrls: Iterable<string>,
  signal: AbortSignal,
  opts?: ExplicitQueryOptions,
): Promise<RelayListDiscoveryRead> {
  const result = await queryExplicitRelaysWithStatus(
    nostr,
    relayUrls,
    [{ kinds: [KIND_RELAY_LIST], authors: [pubkey], limit: 1 }],
    signal,
    opts,
  );
  const event = newestRelayList(
    result.events.filter((candidate) => candidate.pubkey === pubkey),
  );
  if (!event) return result;
  const relays = parseRelayList(event);
  if (relays.length === 0) return result;
  return { ...result, discovery: { event, relays } };
}

/** Fan one already-signed event to every explicit destination. */
export async function publishSignedEventToRelays(
  nostr: RelayPublishClient,
  event: NostrEvent,
  relayUrls: Iterable<string>,
  timeoutMs: number,
): Promise<RelayListPublishResult> {
  const targets = uniqueRelayUrls(relayUrls);
  const settled = await Promise.allSettled(
    targets.map((url) =>
      nostr.relay(url).event(event, { signal: AbortSignal.timeout(timeoutMs) }),
    ),
  );
  return {
    accepted: targets.filter((_, index) => settled[index]?.status === "fulfilled"),
    rejected: targets.filter((_, index) => settled[index]?.status === "rejected"),
  };
}

/** Fan one already-signed relay-list event to every explicit destination. */
export const publishRelayListEvent = publishSignedEventToRelays;

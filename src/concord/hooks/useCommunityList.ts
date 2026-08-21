import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import { useEventStore } from "@/hooks/useEventStore";
import { selfStateRelays } from "@/contexts/AppContext";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import {
  addToList,
  communityListFoldKey,
  EMPTY_COMMUNITY_LIST,
  isExcluded,
  isLive,
  liveEntries,
  markExcluded,
  mergeCommunityLists,
  refreshChannels,
  refreshCurrent,
  refreshRelays,
  rehydrateCommunity,
  removeFromList,
  setControlRoot,
  type CommunityList,
  type PersistedCommunityList,
  type CommunityListEntry,
  type JoinMaterial,
} from "@/concord/lib/communityList";
import {
  defragment,
  emptyFragList,
  fragment,
  parseFragList,
  serializeFragList,
  type FragList,
} from "@/concord/lib/listFrag";
import { STOCK_RELAYS } from "@/concord/lib/invite";
import { KIND_COMMUNITY_LIST_FRAG, KIND_COMMUNITY_LIST_RETIRED } from "@/concord/lib/kinds";
import type { Community } from "@/concord/lib/types";
import { logSync } from "@/lib/syncLog";
import { publishSignedEventToRelays, uniqueRelayUrls } from "@/lib/nip65";
import {
  queueSignedEvent,
  recordQueuedPublishAttempt,
} from "@/lib/publishOutbox";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * The user's Concord Community List — kind-33302 fragment events, NIP-44-
 * encrypted to self (CORD-02 §8). The List IS the vault: it holds the
 * community_root and private-channel keys, so it is the only durable record of
 * Concord membership. Fragmented — one addressable event per fragment, its `d`
 * tag the fragment index — so it grows without a ceiling; a reader unions
 * whatever fragments it holds and holds the COMPLETE List when it has one at
 * every index below the declared total.
 *
 * The disciplines, in CORD-02 §8's terms:
 *  - Newest wins PER INDEX (each fragment is its own coordinate); an age tie
 *    falls to the lowest event id, mirroring relay resolution.
 *  - `frags` disagreement resolves to the newest fragment seen; an age tie to
 *    the LARGER count (too small sends live fragments dormant).
 *  - A short read is read-only: a write over fragments we haven't fully read
 *    would drop the memberships living in the ones we're missing.
 *  - Every write is read-modify-write, and a rebuilt fragment byte-identical
 *    to the relay copy is skipped (a republish would only churn created_at).
 *  - Seeding (the first §8 write for an account migrating off the retired
 *    13302 single event) requires a CONFIRMED-empty read: every relay answers
 *    EOSE with zero fragments, asked one at a time; a read with an error in it
 *    is a FAILED read and never seeds. Latched once it lands.
 *  - Every write is logged — a List publish that silently never lands is the
 *    failure mode this format exists to end.
 *
 * Plus the local disciplines: plaintext-first boot from the folded cache (no
 * signer round-trip), decrypt-once memoization, never letting an undecryptable
 * read clobber a populated list, serialized mutations with strictly-increasing
 * per-fragment `created_at`.
 */

export type ListData = {
  event: NostrRumor | null;
  list: CommunityList;
  decryptFailed?: boolean;
  /** An explicit self-state relay missed the last safe read; poll until it can be repaired. */
  repairPending?: boolean;
};
export type PersistedList = PersistedCommunityList;

export const listQueryKey = (pubkey: string | undefined) => ["concord", "list", pubkey] as const;
const foldKeyOf = communityListFoldKey;

/** Latch: this account has written the fragmented list at least once. */
const seedKeyOf = (pubkey: string) => `concord2-list-seeded:${pubkey}`;
/** Legacy STOCK rescue is retried independently of whether 33302 was seeded. */
const retiredRescueKeyOf = (pubkey: string) => `concord2-retired-list-rescued:${pubkey}`;

/**
 * Junk ceiling on a wire-declared `frags`: 4096 fragments is roughly 230MB of
 * list. A count above it is corrupt, and honoring it would let one bad
 * fragment drive an unbounded completeness scan on every sync.
 */
const MAX_DECLARED_FRAGS = 4096;
/** Per-coordinate relay divergence bound; four stock relays plus user relays stay far below it. */
const MAX_DIVERGENT_EDITIONS = 32;
const FRAGMENT_QUERY_CHUNK = 64;
const LIST_IO_TIMEOUT_MS = 8_000;
const LIST_REPAIR_REFETCH_MS = 60_000;

/** Shared by the mutation and the reconcile's am-I-racing-a-mutation check. */
const LIST_MUTATION_KEY = ["concord-list"] as const;

type NostrLike = {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]>;
  group?(relays: string[]): { query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> };
  relay?(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]>;
    event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown>;
  };
  event?(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown>;
};

/**
 * Decode-once memo for fragment decrypts, keyed by event id. Capped: every
 * publish mints new event ids that get memoized on the next fetch, so a
 * long-lived session grows this forever — evict the oldest half at the cap
 * (Map iteration order is insertion order); a re-decrypt costs one nip44 call.
 */
const fragDecryptMemo = new Map<string, Promise<FragList | null>>();
const FRAG_MEMO_CAP = 1024;

function memoFragDecrypt(id: string, work: Promise<FragList | null>): void {
  if (fragDecryptMemo.size >= FRAG_MEMO_CAP) {
    let drop = fragDecryptMemo.size / 2;
    for (const key of fragDecryptMemo.keys()) {
      if (drop-- <= 0) break;
      fragDecryptMemo.delete(key);
    }
  }
  fragDecryptMemo.set(id, work);
}

function dTagOf(event: NostrRumor): string | undefined {
  return event.tags.find((t) => t[0] === "d")?.[1];
}

/** The fragment index off the `d` tag — a bare decimal, or the event is not a fragment. */
export function fragIndexOf(event: NostrRumor): number | undefined {
  const d = dTagOf(event);
  if (d === undefined || !/^\+?[0-9]+$/.test(d)) return undefined;
  const index = Number(d);
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

async function decryptFragment(
  event: NostrRumor,
  signer: NUser["signer"],
  selfPubkey: string,
): Promise<FragList | null> {
  const nip44 = signer.nip44;
  if (!nip44) return null;
  const cached = fragDecryptMemo.get(event.id);
  if (cached) return cached;
  const work = (async () => {
    try {
      const plaintext = await nip44.decrypt(selfPubkey, event.content);
      return parseFragList(plaintext);
    } catch (err) {
      console.warn("Failed to decrypt Concord community list fragment:", err);
      fragDecryptMemo.delete(event.id); // let a later call retry a transient failure
      return null;
    }
  })();
  memoFragDecrypt(event.id, work);
  return work;
}

/**
 * What a fragment fetch found: the unioned list, and each index's `created_at`
 * so the next write to that fragment can exceed it.
 */
export interface FragSet {
  list: CommunityList;
  /** Per index, the newest known wire or authenticated local created_at floor. */
  createdAt: Map<number, number>;
  /** `frags` as declared by the newest fragment seen (age tie → larger). */
  declared: number;
  /**
   * The winning parsed fragment per index — what the relays currently hold,
   * so a rewrite can skip publishing byte-identical fragments.
   */
  readFrags: Map<number, FragList>;
  /** The signed relay-read winner for each coordinate, used for exact mirroring. */
  winningEvents: Map<number, NostrRumor>;
  /** The newest known wire or authenticated local event (for cache identity / logging). */
  newestEvent: NostrRumor | null;
  /** Coverage, not agreement: an index at every slot below `declared`. */
  complete: boolean;
  /** The wire declared more fragments than this client will ever scan. */
  declaredOverflow: boolean;
}

/** The explicit rescue/write set for the encrypted Concord vault. */
export function communityListRelays(selfRelays: Iterable<string>): string[] {
  return uniqueRelayUrls([...selfRelays, ...STOCK_RELAYS]);
}

function newestEventFirst(a: NostrRumor, b: NostrRumor): number {
  return b.created_at - a.created_at || a.id.localeCompare(b.id);
}

/** Decode and resolve a set of fragment events without doing network I/O. */
export async function decodeCommunityListFragments(
  sourceEvents: Iterable<NostrRumor>,
  user: NUser,
): Promise<{ set: FragSet | null; unreadable: boolean }> {
  const events = new Map<string, NostrRumor>();
  for (const event of sourceEvents) events.set(event.id, event);
  if (events.size === 0) return { set: null, unreadable: false };

  // Resolve each addressable coordinate BEFORE decrypting it. Falling back to
  // an older readable copy when the NIP-01 head is unreadable would base a new
  // write on stale plaintext and permanently shadow the head's unknown facts.
  const editions = new Map<number, NostrRumor[]>();
  for (const event of events.values()) {
    const index = fragIndexOf(event);
    if (index === undefined) continue;
    const held = editions.get(index) ?? [];
    held.push(event);
    editions.set(index, held);
  }
  const newest = new Map<number, { at: number; id: string; frag: FragList; event: NostrRumor }>();
  let unreadable = false;
  let list = EMPTY_COMMUNITY_LIST;
  let readableEditions = 0;
  for (const index of [...editions.keys()].sort((a, b) => a - b)) {
    const candidates = editions.get(index)!
      .sort(newestEventFirst)
      .slice(0, MAX_DIVERGENT_EDITIONS);
    const head = candidates[0]!;
    const headFrag = await decryptFragment(head, user.signer, user.pubkey);
    if (!headFrag) {
      unreadable = true;
    } else {
      newest.set(index, {
        at: head.created_at,
        id: head.id,
        frag: headFrag,
        event: head,
      });
    }

    // A replaceable head controls coordinate ordering, but older divergent
    // relay editions are CRDT inputs rather than fallbacks. Fold every bounded
    // readable edition oldest -> newest so a recovered membership/tombstone or
    // key held only by a lagging relay survives the next rewrite. An unreadable
    // head still blocks writes above; readable losers are used for recovery
    // only and never masquerade as that coordinate's authoritative edition.
    for (const event of [...candidates].reverse()) {
      const frag = event.id === head.id
        ? headFrag
        : await decryptFragment(event, user.signer, user.pubkey);
      if (!frag) continue;
      readableEditions += 1;
      list = mergeCommunityLists(list, defragment([frag]));
    }
  }
  if (readableEditions === 0) {
    logSync("list2", `${events.size} fragment event(s) fetched, none readable — treating as no news`);
    return { set: null, unreadable: editions.size > 0 };
  }

  let wireDeclared = 1;
  let best: { at: number; frags: number } | undefined;
  for (const { at, frag } of newest.values()) {
    if (!best || at > best.at || (at === best.at && frag.frags > best.frags)) {
      best = { at, frags: frag.frags };
    }
  }
  if (best) wireDeclared = Math.max(best.frags, 1);
  const declaredOverflow = wireDeclared > MAX_DECLARED_FRAGS;
  const declared = Math.min(wireDeclared, MAX_DECLARED_FRAGS);

  const indices = [...newest.keys()].sort((a, b) => a - b);
  const readFrags = new Map<number, FragList>(indices.map((i) => [i, newest.get(i)!.frag]));
  const winningEvents = new Map<number, NostrRumor>(indices.map((i) => [i, newest.get(i)!.event]));
  const createdAt = new Map<number, number>(indices.map((i) => [i, newest.get(i)!.at]));
  let complete = !declaredOverflow;
  for (let i = 0; complete && i < declared; i++) complete = createdAt.has(i);
  const newestEvent = [...winningEvents.values()].sort(newestEventFirst)[0] ?? null;
  if (!complete) {
    logSync("list2", `INCOMPLETE: hold ${createdAt.size} of ${declared} fragment(s) — reading, refusing to write`);
  }
  return {
    set: {
      list,
      createdAt,
      declared,
      readFrags,
      winningEvents,
      newestEvent,
      complete,
      declaredOverflow,
    },
    unreadable,
  };
}

async function queryCommunityRelays(
  nostr: NostrLike,
  relayUrls: string[],
  filters: NostrFilter[],
  signal?: AbortSignal,
): Promise<{
  events: NostrRumor[];
  /** Events retain their source so an aggregate winner cannot hide a stale relay. */
  eventsByRelay: Map<string, NostrRumor[]>;
  answered: string[];
  failed: string[];
}> {
  const timeout = () => AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(LIST_IO_TIMEOUT_MS),
  ]);
  if (relayUrls.length === 0 || !nostr.relay) {
    if (typeof nostr.query !== "function") {
      return { events: [], eventsByRelay: new Map(), answered: [], failed: relayUrls };
    }
    try {
      const events = await nostr.query(filters, { signal: timeout() });
      // A pool-wide result cannot prove that any one requested relay reached
      // EOSE. It remains useful to read, but it is never writable evidence.
      return { events, eventsByRelay: new Map(), answered: [], failed: relayUrls };
    } catch {
      return { events: [], eventsByRelay: new Map(), answered: [], failed: relayUrls };
    }
  }
  const settled = await Promise.allSettled(
    relayUrls.map((url) => nostr.relay!(url).query(filters, { signal: timeout() })),
  );
  const byId = new Map<string, NostrRumor>();
  const eventsByRelay = new Map<string, NostrRumor[]>();
  const answered: string[] = [];
  const failed: string[] = [];
  for (let index = 0; index < settled.length; index++) {
    const result = settled[index]!;
    const url = relayUrls[index]!;
    if (result.status !== "fulfilled") {
      failed.push(url);
      continue;
    }
    answered.push(url);
    eventsByRelay.set(url, result.value);
    for (const event of result.value) byId.set(event.id, event);
  }
  return { events: [...byId.values()], eventsByRelay, answered, failed };
}

export interface CommunityListFetchResult {
  set: FragSet | null;
  unreadable: boolean;
  /** Relay-local authoritative fragment heads, only for fully answered relays. */
  readFragsByRelay: Map<string, Map<number, FragList>>;
  /** Explicit destinations that completed every query needed for this read. */
  answered: string[];
  failed: string[];
  targets: string[];
}

/**
 * Fetch the account's 33302 fragments and union them. Reads each explicit
 * self-state/NIP-65 relay AND the stock CORD rescue set independently, because
 * part of a lattice may live only on either side after a partial publish.
 * Returns `null` when no fragment events exist anywhere reachable, and
 * `{ set: undefined }`-like "no news" (all-unreadable) via `unreadable`.
 */
export async function fetchCommunityListFragments(
  nostr: NostrLike,
  user: NUser,
  selfRelays: Iterable<string>,
  signal?: AbortSignal,
  localEvents: Iterable<NostrRumor> = [],
  wireSeedEvents: Iterable<NostrRumor> = [],
): Promise<CommunityListFetchResult> {
  const targets = communityListRelays(selfRelays);
  const listFilter: NostrFilter[] = [{
    kinds: [KIND_COMMUNITY_LIST_FRAG],
    authors: [user.pubkey],
    limit: MAX_DECLARED_FRAGS,
  }];
  // NPool.query CANNOT signal failure: on abort it "returns partial results
  // instead of throwing", so a dead network and an empty account read the
  // same. Writers must therefore never take an empty fetch at face value —
  // the mutation cross-checks it against local evidence of prior fragments,
  // and seeding independently confirms emptiness per relay.
  // Keep locally-filed editions separate from relay editions. Local rumors
  // are authenticated CRDT input and a created_at floor, but they are not
  // evidence of what any relay currently holds. In particular, letting a
  // newer ArmadaDB snapshot become `readFrags` makes the reconcile compare
  // the desired list with that local snapshot, decide the wire is already
  // current, and skip the very repair Setup Sync was asked to perform.
  const localById = new Map<string, NostrRumor>();
  for (const event of localEvents) {
    if (event.kind === KIND_COMMUNITY_LIST_FRAG && event.pubkey === user.pubkey) {
      localById.set(event.id, event);
    }
  }
  const wireById = new Map<string, NostrRumor>();
  // A caller may already have fetched these signed events from the same relay
  // cohort as part of a wider portable-state query. Preserve their wire
  // provenance instead of misclassifying that read as a local ArmadaDB seed.
  for (const event of wireSeedEvents) {
    if (event.kind === KIND_COMMUNITY_LIST_FRAG && event.pubkey === user.pubkey) {
      wireById.set(event.id, event);
    }
  }
  const wireByRelay = new Map<string, Map<string, NostrRumor>>();
  const rememberRelayEvents = (byRelay: Map<string, NostrRumor[]>) => {
    for (const [url, events] of byRelay) {
      const held = wireByRelay.get(url) ?? new Map<string, NostrRumor>();
      for (const event of events) held.set(event.id, event);
      wireByRelay.set(url, held);
    }
  };
  const combinedEvents = () => new Map([
    ...wireById,
    ...localById,
  ]).values();
  const initial = await queryCommunityRelays(nostr, targets, listFilter, signal);
  const answered = new Set(initial.answered);
  const failed = new Set(initial.failed);
  rememberRelayEvents(initial.eventsByRelay);
  for (const event of initial.events) wireById.set(event.id, event);
  let decoded = await decodeCommunityListFragments(combinedEvents(), user);
  let wireDecoded = await decodeCommunityListFragments(wireById.values(), user);

  // Some relays cap every response at 64 even when the requested limit is
  // higher. Once any readable fragment tells us the lattice width, explicitly
  // address the missing coordinates in bounded chunks. This turns the old
  // silent 64-fragment short read into either a complete vault or an honest,
  // read-only incomplete result.
  // A local edition can fill a coordinate that the bounded relay response
  // omitted. Still query that coordinate explicitly before writing: the
  // relay may hold a divergent CRDT fact that must join the union first.
  if (decoded.set && !decoded.set.declaredOverflow) {
    const missing = new Set<string>();
    for (let i = 0; i < decoded.set.declared; i++) {
      if (!wireDecoded.set?.createdAt.has(i)) missing.add(String(i));
    }
    // Aggregate coverage is not per-relay coverage: relay A can satisfy every
    // coordinate while relay B's capped response omits its upper half. Query
    // every missing relay-local coordinate before B becomes a write target.
    // A wholly-empty answered relay needs no follow-up — the broad EOSE already
    // proved that every coordinate is absent there.
    for (const url of answered) {
      const events = wireByRelay.get(url);
      if (!events || events.size === 0) continue;
      const indices = new Set(
        [...events.values()]
          .map(fragIndexOf)
          .filter((index): index is number => index !== undefined),
      );
      for (let i = 0; i < decoded.set.declared; i++) {
        if (!indices.has(i)) missing.add(String(i));
      }
    }
    const missingIndices = [...missing];
    for (let offset = 0; offset < missingIndices.length; offset += FRAGMENT_QUERY_CHUNK) {
      const chunk = missingIndices.slice(offset, offset + FRAGMENT_QUERY_CHUNK);
      const recovery = await queryCommunityRelays(nostr, targets, [{
        kinds: [KIND_COMMUNITY_LIST_FRAG],
        authors: [user.pubkey],
        "#d": chunk,
        limit: chunk.length,
      }], signal);
      for (const url of recovery.failed) {
        failed.add(url);
        answered.delete(url);
      }
      rememberRelayEvents(recovery.eventsByRelay);
      for (const event of recovery.events) wireById.set(event.id, event);
    }
    decoded = await decodeCommunityListFragments(combinedEvents(), user);
    wireDecoded = await decodeCommunityListFragments(wireById.values(), user);
  }

  // `list`, `createdAt`, completeness and newestEvent include authenticated
  // local editions so a repair neither loses facts nor signs below a queued
  // local coordinate. The skip/mirror fields stay relay-only: they describe
  // what the completed reads actually proved is on the wire.
  const set = decoded.set
    ? {
      ...decoded.set,
      readFrags: wireDecoded.set?.readFrags ?? new Map<number, FragList>(),
      winningEvents: wireDecoded.set?.winningEvents ?? new Map<number, NostrRumor>(),
    }
    : null;
  const readFragsByRelay = new Map<string, Map<number, FragList>>();
  for (const url of answered) {
    const relayDecoded = await decodeCommunityListFragments(
      wireByRelay.get(url)?.values() ?? [],
      user,
    );
    // `unreadable` is already reflected by the aggregate decode above. Keep
    // the relay map absent unless its head set is readable; publish targeting
    // treats an absent map as unproven and will never write to it.
    if (relayDecoded.unreadable) continue;
    readFragsByRelay.set(url, relayDecoded.set?.readFrags ?? new Map());
  }
  return {
    set,
    unreadable: decoded.unreadable || wireDecoded.unreadable,
    readFragsByRelay,
    answered: [...answered],
    failed: [...failed],
    targets,
  };
}

/**
 * Publish a list as fragments. Each fragment's `created_at` must exceed that
 * fragment's own previous value — relays resolve an addressable event on
 * `created_at` alone and break a tie on the lowest event id, so a same-second
 * rewrite can silently discard the newer content. A fragment serializing to
 * the bytes just read is already on the relay and is skipped. A shrunk set
 * empties the fragments above it, so a later growth into that index cannot
 * re-read stale memberships. Returns the newest signed fragment event.
 */
async function publishFragments(
  nostr: NostrLike,
  user: NUser,
  list: CommunityList,
  prevCreatedAt: Map<number, number>,
  readFrags: Map<number, FragList>,
  targetRelays: Iterable<string>,
  readFragsByRelay?: ReadonlyMap<string, ReadonlyMap<number, FragList>>,
): Promise<NostrRumor | null> {
  if (!user.signer.nip44) throw new Error("NIP-44 encryption not supported by this signer");
  // Exact read cohort only. An unanswered relay may hold a newer CRDT fact;
  // queueing this rewrite there for later would overwrite that unseen fact.
  const targets = uniqueRelayUrls(targetRelays);
  // BIND, don't copy: the real client is a NostrBatcher instance and `relay` is
  // a method that reads `this.pool`. Lifting the bare function reference into
  // an object literal detaches the receiver, so the call lands with `this` set
  // to that literal and fails on `this.pool` being undefined.
  const relay = nostr.relay?.bind(nostr);
  if (targets.length === 0 || !relay) {
    throw new Error("No relay is available for your community list update");
  }
  const publishNostr = { relay };
  const frags = fragment(list);
  const now = Math.floor(Date.now() / 1000);
  const unchanged = (index: number, frag: FragList): boolean => {
    const old = readFrags.get(index);
    return old !== undefined && serializeFragList(old) === serializeFragList(frag);
  };
  const targetsNeeding = (index: number, frag: FragList): string[] => {
    if (!readFragsByRelay) return unchanged(index, frag) ? [] : targets;
    const serialized = serializeFragList(frag);
    return targets.filter((target) => {
      const relayRead = readFragsByRelay.get(target);
      // No completed, decryptable relay-local read means no authority to write
      // there. In normal fetch results every `answered` target has a map;
      // keeping this guard fail-closed prevents a future caller from widening
      // a safe cohort accidentally.
      if (!relayRead) return false;
      const old = relayRead.get(index);
      return old === undefined || serializeFragList(old) !== serialized;
    });
  };
  // Persisted, not level-gated: a List write that silently never lands is the
  // failure mode this whole format exists to end, and it is only ever
  // diagnosed after the fact.
  logSync(
    "list2",
    `publishing ${frags.length} fragment(s): ${frags.reduce((n, f) => n + f.entries.length, 0)} live entries (${list.entries.length - frags.reduce((n, f) => n + f.entries.length, 0)} retired), ${frags.reduce((n, f) => n + f.tombstones.length, 0)} tombstones`,
  );

  let skipped = 0;
  let newest: NostrRumor | null = null;
  const publishOne = async (frag: FragList, index: number, fragmentTargets: string[]) => {
    const createdAt = Math.max(now, (prevCreatedAt.get(index) ?? 0) + 1);
    const plaintext = serializeFragList(frag);
    const content = await user.signer.nip44!.encrypt(user.pubkey, plaintext);
    const event = await user.signer.signEvent({
      kind: KIND_COMMUNITY_LIST_FRAG,
      content,
      tags: [["d", String(index)]],
      created_at: createdAt,
    });
    // Queue the exact signed bytes BEFORE touching the network. Every target
    // remains explicit in the retry entry; a generic pool acknowledgement is
    // not proof that the NIP-65/stock rescue set holds the vault.
    // If this durable enqueue fails, do not touch the network: a partial
    // fan-out would otherwise have no exact-byte retry record.
    await queueSignedEvent(event, undefined, fragmentTargets, { inheritPendingTargets: false });
    const result = await publishSignedEventToRelays(
      publishNostr,
      event,
      fragmentTargets,
      LIST_IO_TIMEOUT_MS,
    );
    await recordQueuedPublishAttempt(event.id, fragmentTargets, result.rejected).catch(() => undefined);
    if (result.accepted.length === 0) {
      // The exact signed bytes and cohort are already durable. Treat this as
      // a pending delivery rather than rolling the semantic mutation back:
      // the folded list below is what keeps a just-joined community visible
      // after reload, and the outbox will retry these same bytes. Continue so
      // every changed fragment in a multi-fragment vault is queued too.
      logSync("list2", `fragment ${index} accepted by no relay — durably queued for retry`);
    }
    if (result.rejected.length > 0) {
      logSync(
        "list2",
        `fragment ${index} accepted by ${result.accepted.length} relay(s); ${result.rejected.length} queued for retry`,
      );
    }
    if (!newest || event.created_at >= newest.created_at) newest = event;
  };

  // DESCENDING, top index first. When the set GROWS, ascending order is a
  // wedge: fragment 0 (declaring the new total) lands, the network dies before
  // the brand-new top index publishes, and now every read sees a declared
  // count with a permanently-missing index — incomplete forever, and the
  // incomplete-read refusal blocks the very write that could repair it. Top
  // index first, coverage survives any prefix of failures: either the new top
  // (declaring N+1) lands alongside the old fragment 0 (still declaring N), or
  // nothing changed — both leave a complete, retryable wire.
  for (let index = frags.length - 1; index >= 0; index--) {
    const fragmentTargets = targetsNeeding(index, frags[index]);
    if (fragmentTargets.length === 0) {
      skipped++;
      continue;
    }
    await publishOne(frags[index], index, fragmentTargets);
  }
  // A shrunk set empties every READ index at or above the new count — the
  // actual keys, not a count-bounded range: a sparse read set (relays evicted
  // the middle, a stale fossil survives above) must empty the fossil NOW, not
  // one index per sync until the count catches up to it.
  for (const index of [...prevCreatedAt.keys()].sort((a, b) => a - b)) {
    if (index < frags.length) continue;
    const empty = emptyFragList(frags.length);
    const fragmentTargets = targetsNeeding(index, empty);
    if (fragmentTargets.length === 0) {
      skipped++;
      continue;
    }
    await publishOne(empty, index, fragmentTargets);
  }
  if (skipped > 0) {
    logSync("list2", `${skipped} fragment(s) skipped — byte-identical to the relay copy`);
  }
  return newest;
}

/**
 * Whether publishing `frags` would change what the relays hold: some rebuilt
 * fragment differs byte-wise from the wire copy at its index, or a READ index
 * beyond the rebuilt set isn't already the matching empty List. Exactly the
 * writes {@link publishFragments} would NOT skip — the two must stay in
 * lockstep or the reconcile publishes forever (or never).
 */
function wireDiffers(frags: FragList[], read: Map<number, FragList>): boolean {
  for (let i = 0; i < frags.length; i++) {
    const old = read.get(i);
    if (!old || serializeFragList(old) !== serializeFragList(frags[i])) return true;
  }
  const empty = serializeFragList(emptyFragList(frags.length));
  for (const [i, old] of read) {
    if (i >= frags.length && serializeFragList(old) !== empty) return true;
  }
  return false;
}

/** Whether any safely answered relay is stale or missing at least one coordinate. */
function relayWireDiffers(
  frags: FragList[],
  reads: ReadonlyMap<string, Map<number, FragList>>,
  relays: Iterable<string>,
): boolean {
  for (const relay of relays) {
    const read = reads.get(relay);
    // Missing provenance is not an empty relay read. Fail closed: only a map
    // established by that relay's completed/decryptable query can authorize a
    // targeted repair.
    if (read && wireDiffers(frags, read)) return true;
  }
  return false;
}

/** Whether a complete wire fragment set already represents this merged list. */
export function communityListWireDiffers(list: CommunityList, set: FragSet): boolean {
  return wireDiffers(fragment(list), set.readFrags);
}

/**
 * Sign a complete, consolidated vault snapshot without publishing it. Relay
 * rotation uses this when divergent editions (including one found only on a
 * proposed relay) must be collapsed before that relay can become
 * authoritative. Every live and retired coordinate is rewritten so the
 * caller has one exact signed head per d-tag to fan out and verify.
 */
export async function signCommunityListSnapshot(
  user: NUser,
  list: CommunityList,
  previous: FragSet | null,
): Promise<NostrEvent[]> {
  if (!user.signer.nip44) throw new Error("NIP-44 encryption not supported by this signer");
  const frags = fragment(list);
  const indices = new Set<number>([
    ...frags.map((_, index) => index),
    ...(previous ? previous.createdAt.keys() : []),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const events: NostrEvent[] = [];
  for (const index of [...indices].sort((a, b) => b - a)) {
    const frag = frags[index] ?? emptyFragList(frags.length);
    const event = await user.signer.signEvent({
      kind: KIND_COMMUNITY_LIST_FRAG,
      content: await user.signer.nip44.encrypt(user.pubkey, serializeFragList(frag)),
      tags: [["d", String(index)]],
      created_at: Math.max(now, (previous?.createdAt.get(index) ?? 0) + 1),
    });
    if (event.pubkey !== user.pubkey) throw new Error("The signer returned a different account");
    events.push(event);
  }
  return events;
}

/**
 * Every relay answered EOSE with zero fragments — the only reading of "empty"
 * strong enough to seed over. The aggregate fetch that precedes this cannot
 * distinguish "no fragments" from "the relay holding them never answered";
 * asked one at a time, an error is a FAILED read and a failed read never seeds.
 */
async function confirmedEmptyFragmentRelays(
  nostr: NostrLike,
  pubkey: string,
  relays: string[],
): Promise<{ answered: string[]; sawFragments: boolean }> {
  if (relays.length === 0 || !nostr.relay) return { answered: [], sawFragments: false };
  const filter: NostrFilter[] = [{ kinds: [KIND_COMMUNITY_LIST_FRAG], authors: [pubkey], limit: 1 }];
  const answered: string[] = [];
  let sawFragments = false;
  for (const url of relays) {
    try {
      const events = await nostr.relay(url).query(filter, { signal: AbortSignal.timeout(8000) });
      answered.push(url);
      if (events.length > 0) sawFragments = true;
    } catch {
      // Unanswered relays are excluded from this write cohort. They may hold a
      // richer edition, so no newly based fragment is queued to them.
    }
  }
  return { answered, sawFragments };
}

/**
 * First write of the §8 List for an account that has none: an account
 * upgrading from the retired single-event list arrives here with memberships
 * that exist only in local state (the folded cache), and nothing else in the
 * stack publishes without a membership change to record. Latched once it
 * lands, so a boot-load read that comes back empty can never republish local
 * state over a sibling's tombstones. Seeding over a read that merely FAILED
 * would publish fragment 0 over a sibling device's tombstones at a fresh
 * created_at — hence the per-relay confirmation.
 */
async function seedCommunityList(
  nostr: NostrLike,
  user: NUser,
  queryClient: QueryClient,
  selfRelays: string[],
): Promise<void> {
  const alreadySeeded = await readFolded<boolean>(seedKeyOf(user.pubkey));
  const cached = queryClient.getQueryData<ListData>(listQueryKey(user.pubkey));
  const local = cached?.list ?? (await readFolded<PersistedList>(foldKeyOf(user.pubkey)))?.list;

  // The retired single-event list (13302) is read exactly ONCE, here, as a
  // rescue source. Local state is the primary migration path, but a web
  // client's local state is evictable — a reinstall or a fresh device arrives
  // with an empty folded cache while the account's whole vault (community
  // roots, channel keys, priors) sits in a 13302 nothing else will ever
  // decrypt again. A rescue failure DEFERS the seed rather than seeding
  // partial state and latching away the only retry.
  let rescued: CommunityList | undefined;
  if (!(await readFolded<boolean>(retiredRescueKeyOf(user.pubkey)))) {
    try {
      const rescue = await fetchRetiredList(nostr, user, selfRelays);
      rescued = rescue.list;
      if (rescue.complete) await writeFolded(retiredRescueKeyOf(user.pubkey), true);
    } catch (err) {
      logSync(
        "list2",
        `retired-list rescue failed (${err instanceof Error ? err.message : String(err)}); retrying on a later sync`,
      );
    }
  }
  const source = local && rescued ? mergeCommunityLists(local, rescued) : (local ?? rescued);
  if (!source || (source.entries.length === 0 && source.tombstones.length === 0)) return;
  if (alreadySeeded) {
    // A previous 33302 seed may still be propagating. Keep any newly-recovered
    // retired facts durable; once a fragment is visible, the ordinary
    // reconcile below republishes their union over a confirmed base.
    if (rescued) {
      const event = cached?.event ?? null;
      await writeFolded(foldKeyOf(user.pubkey), { event, list: source } satisfies PersistedList);
      queryClient.setQueryData<ListData>(listQueryKey(user.pubkey), { event, list: source });
    }
    return;
  }

  const confirm = communityListRelays(selfRelays);
  const empty = await confirmedEmptyFragmentRelays(nostr, user.pubkey, confirm);
  const canonical = uniqueRelayUrls(selfRelays);
  const requiredFloor = canonical.length > 0 ? canonical : uniqueRelayUrls(STOCK_RELAYS);
  if (empty.sawFragments || !empty.answered.some((url) => requiredFloor.includes(url))) {
    logSync("list2", "seed DEFERRED — the empty read is unconfirmed; retrying on a later sync");
    return;
  }
  logSync(
    "list2",
    `no fragments held anywhere (confirmed per relay) — seeding from ${rescued ? "local state + the retired 13302" : "local state"}`,
  );
  try {
    const newest = await publishFragments(nostr, user, source, new Map(), new Map(), empty.answered);
    await writeFolded(seedKeyOf(user.pubkey), true);
    void writeFolded(foldKeyOf(user.pubkey), { event: newest, list: source } satisfies PersistedList);
    if (newest) {
      queryClient.setQueryData<ListData>(listQueryKey(user.pubkey), { event: newest, list: source });
    }
  } catch (err) {
    logSync("list2", `seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Best-effort read of the retired kind-13302 single-event list. `complete`
 * means every historical STOCK rescue source has answered at least once; a
 * current NIP-65 relay cannot prove that an offline STOCK copy is absent.
 * Until complete, the caller keeps retrying even after 33302 has been seeded.
 */
async function fetchRetiredList(
  nostr: NostrLike,
  user: NUser,
  selfRelays: Iterable<string>,
): Promise<{ list?: CommunityList; complete: boolean }> {
  if (!user.signer.nip44) return { complete: false };
  const filter: NostrFilter[] = [
    { kinds: [KIND_COMMUNITY_LIST_RETIRED], authors: [user.pubkey], limit: 1 },
  ];
  const latest = (await queryCommunityRelays(
    nostr,
    communityListRelays(selfRelays),
    filter,
  ));
  const answered = new Set(latest.answered);
  const complete = uniqueRelayUrls(STOCK_RELAYS).every((url) => answered.has(url));
  const event = latest.events.sort(newestEventFirst)[0];
  if (!event?.content) return { complete };
  const plaintext = await user.signer.nip44.decrypt(user.pubkey, event.content);
  const parsed = JSON.parse(plaintext) as Partial<CommunityList>;
  return {
    complete,
    list: {
      ...parsed,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
    } as CommunityList,
  };
}

/**
 * Fetch the kind-33302 fragments, union them, and merge into the cached list.
 * Shared by the hook's queryFn and the post-login gate. Merge-never-replace
 * so a short relay read can't drop rooms; persists the merged plaintext to
 * the folded cache. `selfRelays` (the account's self-state write set) enables
 * the confirmed-empty seeding path; without it an empty read is just empty.
 */
export async function syncCommunityList(
  nostr: NostrLike,
  user: NUser,
  queryClient: QueryClient,
  signal?: AbortSignal,
  selfRelays?: string[],
  seedEvents: Iterable<NostrRumor> = [],
): Promise<ListData> {
  const queryKey = listQueryKey(user.pubkey);
  const prev = queryClient.getQueryData<ListData>(queryKey);
  const read = await fetchCommunityListFragments(
    nostr,
    user,
    selfRelays ?? [],
    signal,
    seedEvents,
  );
  const { set, unreadable } = read;
  const explicit = uniqueRelayUrls(selfRelays ?? []);
  const repairFloor = explicit.length > 0 ? explicit : uniqueRelayUrls(STOCK_RELAYS);
  const repairPending = selfRelays !== undefined && (
    unreadable
    || Boolean(set && !set.complete)
    || read.failed.some((url) => repairFloor.includes(url))
  );

  if (!set) {
    if (unreadable) {
      // Never let an undecryptable read clobber a populated list (the keys
      // live here; a wrongful empty would vanish the rooms).
      return {
        ...(prev ?? { event: null, list: EMPTY_COMMUNITY_LIST, decryptFailed: true }),
        repairPending,
      };
    }
    logSync("list2", "relay fetch: no fragments");
    if (selfRelays) await seedCommunityList(nostr, user, queryClient, selfRelays);
    const next = (
      queryClient.getQueryData<ListData>(queryKey) ?? prev ?? { event: null, list: EMPTY_COMMUNITY_LIST }
    );
    return { ...next, repairPending };
  }

  logSync(
    "list2",
    `relay fetch: ${set.createdAt.size} of ${set.declared} fragment(s), ${set.list.entries.length} entries, ${set.list.tombstones.length} tombstones`,
  );

  // Merge, never replace: a transient short relay read can't drop rooms;
  // the deterministic merge still honors genuine tombstones. On the first
  // sync of a boot the query cache may not be primed yet, so fall back to the
  // folded plaintext — it is what holds the memberships recorded under the
  // retired single-event list, which only exist locally.
  const local =
    prev?.list ?? (await readFolded<PersistedList>(foldKeyOf(user.pubkey)))?.list;
  let retired: CommunityList | undefined;
  if (!(await readFolded<boolean>(retiredRescueKeyOf(user.pubkey)))) {
    try {
      const rescue = await fetchRetiredList(nostr, user, selfRelays ?? []);
      retired = rescue.list;
      if (rescue.complete) await writeFolded(retiredRescueKeyOf(user.pubkey), true);
    } catch (error) {
      logSync(
        "list2",
        `retired-list rescue failed (${error instanceof Error ? error.message : String(error)}); retrying on a later sync`,
      );
    }
  }
  const liveAndLocal = local ? mergeCommunityLists(local, set.list) : set.list;
  const merged = retired ? mergeCommunityLists(liveAndLocal, retired) : liveAndLocal;
  const next: ListData = {
    event: set.newestEvent,
    list: merged,
    decryptFailed: false,
    repairPending,
  };
  void writeFolded(foldKeyOf(user.pubkey), { event: set.newestEvent, list: merged } satisfies PersistedList);

  // Reconcile — the migration write. Seeding only covers an account whose
  // fragment read is CONFIRMED empty; an account whose OTHER client (Vector)
  // already seeded §8 arrives here with a non-empty wire that lacks the
  // memberships this device recorded under the retired 13302 — and, having
  // "finished" migrating, has no membership edit left to trigger a write
  // (CORD-02 §8's stranding trap). So when the union knows more than the
  // wire — different bytes after a COMPLETE read — publish it. Timestamps are
  // untouched (a tombstoned membership stays dead, seed anchors only widen),
  // it is read-modify-write over the fragments just read, and the per-fragment
  // no-op skip makes it free once converged.
  // Skipped while a list mutation is in flight: the mutation snapshotted its
  // own per-index created_at map, and a reconcile publish racing it hands the
  // relay a same-second lowest-id coin-flip the mutation can lose. The next
  // sync re-arms the reconcile with fresh state, so skipping costs nothing.
  const canonical = uniqueRelayUrls(selfRelays ?? []);
  const requiredFloor = canonical.length > 0 ? canonical : uniqueRelayUrls(STOCK_RELAYS);
  const hasCanonicalAnswer = read.answered.some((url) => requiredFloor.includes(url));
  if (selfRelays && set.complete && !unreadable && hasCanonicalAnswer && user.signer.nip44
    && queryClient.isMutating({ mutationKey: LIST_MUTATION_KEY }) === 0) {
    try {
      const rebuilt = fragment(merged);
      if (relayWireDiffers(rebuilt, read.readFragsByRelay, read.answered)) {
        // Keep one confirming poll armed. EVENT acceptance is not proof that
        // an addressable head is query-visible yet (or retained as winner).
        next.repairPending = true;
        logSync("list2", "reconcile: the union or a relay-local copy is stale — publishing it");
        const newest = await publishFragments(
          nostr,
          user,
          merged,
          set.createdAt,
          set.readFrags,
          read.answered,
          read.readFragsByRelay,
        );
        void writeFolded(seedKeyOf(user.pubkey), true);
        if (newest) next.event = newest;
      }
    } catch (err) {
      // Non-fatal: the read side of this sync already succeeded, and the
      // reconcile re-arms on every later sync until it lands.
      next.repairPending = true;
      logSync(
        "list2",
        `reconcile publish failed (${err instanceof Error ? err.message : String(err)}) — retrying on a later sync`,
      );
    }
  }
  return next;
}

/** Query the latest Concord Community List, plaintext-cache-first. */
export function useCommunityList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = listQueryKey(user?.pubkey);
  const foldKey = user ? foldKeyOf(user.pubkey) : null;

  // Plaintext-first boot: read the previously-decrypted list without a signer
  // (a remote signer's nip44 can be unavailable for seconds on reopen and the
  // rail must not blank meanwhile). Falls back to a one-time decrypt of the
  // locally-mirrored fragments once the signer is ready.
  useEffect(() => {
    if (!user || !foldKey) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;
      const persisted = await readFolded<PersistedList>(foldKey);
      if (cancelled) return;
      if (persisted) {
        logSync("list2", `boot from folded cache: ${persisted.list.entries.length} entry(ies)`);
        queryClient.setQueryData<ListData>(queryKey, { event: persisted.event ?? null, list: persisted.list });
        return;
      }
      if (!user.signer.nip44) return;
      const store = await eventStore;
      const cached = await store.query([{ kinds: [KIND_COMMUNITY_LIST_FRAG], authors: [user.pubkey] }]);
      if (cancelled || cached.length === 0) return;
      // Newest per index, then union — the same read discipline as the wire.
      const newest = new Map<number, { at: number; id: string; frag: FragList; event: NostrRumor }>();
      for (const event of cached) {
        const index = fragIndexOf(event);
        if (index === undefined) continue;
        const frag = await decryptFragment(event, user.signer, user.pubkey);
        if (!frag) continue;
        const prev = newest.get(index);
        const wins = !prev || event.created_at > prev.at || (event.created_at === prev.at && event.id < prev.id);
        if (wins) newest.set(index, { at: event.created_at, id: event.id, frag, event });
      }
      if (cancelled || newest.size === 0) return;
      const indices = [...newest.keys()].sort((a, b) => a - b);
      const list = defragment(indices.map((i) => newest.get(i)!.frag));
      const newestEvent = [...newest.values()].reduce<NostrRumor | null>(
        (a, b) => (a && a.created_at >= b.event.created_at ? a : b.event),
        null,
      );
      if (!queryClient.getQueryData(queryKey)) {
        queryClient.setQueryData<ListData>(queryKey, { event: newestEvent, list });
        // Under the same guard as setQueryData: if a live sync populated the
        // cache while we decrypted, its folded write is fresher than this
        // store-derived list and must not be clobbered by it.
        void writeFolded(foldKey, { event: newestEvent, list } satisfies PersistedList);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, user?.signer.nip44, eventStore, queryClient]);

  return useQuery<ListData>({
    queryKey,
    enabled: Boolean(user?.signer.nip44),
    staleTime: 30_000,
    // A semantic edit never writes to a relay that missed its source read.
    // Keep retrying the safe read while such a relay is outstanding; once it
    // answers, the per-relay reconcile above backfills only its stale/missing
    // coordinates. The standing subscription cannot detect an EMPTY returning
    // relay because it has no event to emit.
    refetchInterval: (query) => query.state.data?.repairPending
      ? LIST_REPAIR_REFETCH_MS
      : false,
    queryFn: async ({ signal }) => {
      let cached: NostrRumor[] = [];
      try {
        cached = await (await eventStore).query([{
          kinds: [KIND_COMMUNITY_LIST_FRAG],
          authors: [user!.pubkey],
        }]);
      } catch {
        // Wire + folded plaintext remain available when ArmadaDB is not.
      }
      return syncCommunityList(
        nostr,
        user!,
        queryClient,
        signal,
        selfStateRelays(config, user!.pubkey),
        cached,
      );
    },
  });
}

/** A mutation against the list (read-modify-write, deterministic, serialized). */
export type CommunityListAction =
  | { type: "add"; entry: CommunityListEntry }
  | { type: "remove"; communityId: string; removedAt?: number }
  | { type: "exclude"; communityId: string; epoch: number }
  | { type: "refresh-current"; current: JoinMaterial }
  | {
      type: "refresh-channels";
      communityId: string;
      channels: JoinMaterial["channels"];
      /** Channels a rotation cut me out of, with the epoch that did it. */
      cuts?: CommunityListEntry["channel_cuts"];
    }
  | { type: "refresh-relays"; communityId: string; relays: string[] }
  | {
      /** A verified `control_wrap` adoption (CORD-04 §3) — see {@link setControlRoot}. */
      type: "set-control-root";
      communityId: string;
      epoch: number;
      controlRootHex: string;
    };

function applyAction(list: CommunityList, action: CommunityListAction): CommunityList {
  switch (action.type) {
    case "add":
      return addToList(list, action.entry);
    case "remove":
      return removeFromList(list, action.communityId, action.removedAt ?? Date.now());
    case "exclude":
      return markExcluded(list, action.communityId, action.epoch);
    case "refresh-current":
      return refreshCurrent(list, action.current);
    case "refresh-channels":
      return refreshChannels(list, action.communityId, action.channels, action.cuts);
    case "refresh-relays":
      return refreshRelays(list, action.communityId, action.relays);
    case "set-control-root":
      return setControlRoot(list, action.communityId, action.epoch, action.controlRootHex);
  }
}

/**
 * The serialized read/modify/write core. Exported so the all-sources-failed
 * guard can be regression-tested without mounting the UI hook.
 */
export async function updateCommunityList(
  nostr: NostrLike,
  user: NUser,
  queryClient: QueryClient,
  relays: string[],
  action: CommunityListAction,
  seedEvents: Iterable<NostrRumor> = [],
): Promise<CommunityList> {
  const read = await fetchCommunityListFragments(
    nostr,
    user,
    relays,
    undefined,
    seedEvents,
  );
  const { set, unreadable } = read;
  if (unreadable) {
    throw new Error(
      "Couldn't read your existing communities (decryption failed); not saving to avoid losing room keys.",
    );
  }
  // Require a canonical account-state answer. Stock is the fallback only for
  // a legacy account with no canonical relay yet. Unanswered rescue relays are
  // deliberately omitted from the write cohort rather than blocking forever.
  const canonical = uniqueRelayUrls(relays);
  const requiredFloor = canonical.length > 0 ? canonical : uniqueRelayUrls(STOCK_RELAYS);
  if (!read.answered.some((url) => requiredFloor.includes(url))) {
    throw new Error(
      "Couldn't confirm your community list on an account-state relay; not saving to avoid overwriting it.",
    );
  }
  if (set && !set.complete) {
    throw new Error(
      `Holding ${set.createdAt.size} of ${set.declared} community-list fragments; try again once the missing ones sync.`,
    );
  }
  if (!set) {
    // The status-bearing read above makes this a confirmed empty wire, but a
    // local record proves this account previously had fragments. Preserve the
    // older conservative refusal: relay data loss is not authority to mint a
    // new fragment 0 over whatever an unconfigured source may still retain.
    const persisted = await readFolded<PersistedList>(foldKeyOf(user.pubkey));
    const seeded = await readFolded<boolean>(seedKeyOf(user.pubkey));
    if (persisted?.event || seeded) {
      throw new Error(
        "Couldn't reach your community list on any relay; not saving to avoid overwriting it.",
      );
    }
  }
  const relayList = set?.list ?? EMPTY_COMMUNITY_LIST;

  // Fold in the local optimistic cache (addressable propagation lags).
  const cached = queryClient.getQueryData<ListData>(listQueryKey(user.pubkey));
  const current = cached ? mergeCommunityLists(cached.list, relayList) : relayList;
  const next = applyAction(current, action);

  const newest = await publishFragments(
    nostr,
    user,
    next,
    set?.createdAt ?? new Map(),
    set?.readFrags ?? new Map(),
    read.answered,
    read.readFragsByRelay,
  );

  const event = newest ?? set?.newestEvent ?? cached?.event ?? null;
  queryClient.setQueryData<ListData>(listQueryKey(user.pubkey), {
    event,
    list: next,
    repairPending: read.failed.some((url) => requiredFloor.includes(url)),
  });
  void writeFolded(foldKeyOf(user.pubkey), { event, list: next } satisfies PersistedList);
  void writeFolded(seedKeyOf(user.pubkey), true);
  return next;
}

export function useUpdateCommunityList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const removeRailKey = useRemoveRailKey();

  return useMutation({
    // Serialize every list mutation onto one queue so back-to-back joins can't
    // interleave read-modify-writes and drop each other's entries. The key is
    // what lets the sync-path reconcile see a mutation in flight and stand down.
    mutationKey: [...LIST_MUTATION_KEY],
    scope: { id: "concord-list" },
    mutationFn: async (action: CommunityListAction) => {
      if (!user) throw new Error("User is not logged in");
      if (!user.signer.nip44) throw new Error("NIP-44 encryption not supported by this signer");

      // Read-modify-write against the explicit self-state/NIP-65 set plus the
      // stock CORD rescue relays, where a pending partial fan-out may have put
      // the newest copy.
      const relays = selfStateRelays(config, user.pubkey);
      let cached: NostrRumor[] = [];
      try {
        cached = await (await eventStore).query([{
          kinds: [KIND_COMMUNITY_LIST_FRAG],
          authors: [user.pubkey],
        }]);
      } catch {
        // A wire-confirmed RMW can still proceed when local storage is down.
      }
      return updateCommunityList(nostr, user, queryClient, relays, action, cached);
    },
    onSuccess: (_next, action) => {
      // Leaving purges the rail-arrangement key too, so a later rejoin doesn't
      // reappear inside the folder it used to live in.
      if (action.type === "remove") removeRailKey(`c2:${action.communityId}`);
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    },
  });
}

/** The LIVE Concord membership entries (tombstoned ones stay in the doc but not here). */
export function useLiveCommunities(): CommunityListEntry[] {
  const { data } = useCommunityList();
  return useMemo(() => (data ? liveEntries(data.list) : []), [data]);
}

/**
 * Rehydrate a runtime {@link Community} from the list entry for `idHex`,
 * verified against the owner commitment, with the deployment's app relays
 * unioned in (community relays first). Stable identity across renders.
 */
export function useCommunity(idHex: string | undefined): Community | undefined {
  const entry = useCommunityEntry(idHex);
  return useMemo(() => (entry ? rehydrateCommunity(entry) : undefined), [entry]);
}

/**
 * The raw list entry for a community (needed to round-trip unknown fields).
 *
 * Resolves only LIVE memberships. A tombstoned entry stays in the list
 * document forever — that's how a leave propagates — but it must not resolve
 * here, or `/c/<id>` would still mount the full community page for a community
 * the user left, arming every watcher on it. Two of those watchers
 * (`useRekeyWatch` adopting a Refounding, `useStrandedRecovery` re-resolving
 * the invite) bump `added_at`, which is exactly what makes a leave undo itself.
 */
export function useCommunityEntry(idHex: string | undefined): CommunityListEntry | undefined {
  const { data } = useCommunityList();
  return useMemo(() => {
    if (!idHex || !data) return undefined;
    if (!isLive(data.list, idHex)) return undefined;
    return data.list.entries.find((e) => e.community_id === idHex);
  }, [data, idHex]);
}

/**
 * Whether I've been EXCLUDED (kicked/banned) from this community at its current
 * epoch — the icon stays, but the community is read-only until a Refounding
 * re-includes me or I leave.
 */
export function useIsExcluded(idHex: string | undefined): boolean {
  const entry = useCommunityEntry(idHex);
  return useMemo(() => (entry ? isExcluded(entry) : false), [entry]);
}

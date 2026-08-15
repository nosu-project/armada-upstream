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
import { KIND_COMMUNITY_LIST_FRAG } from "@/concord/lib/kinds";
import type { Community } from "@/concord/lib/types";
import { logSync } from "@/lib/syncLog";

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

export type ListData = { event: NostrRumor | null; list: CommunityList; decryptFailed?: boolean };
export type PersistedList = PersistedCommunityList;

export const listQueryKey = (pubkey: string | undefined) => ["concord", "list", pubkey] as const;
const foldKeyOf = communityListFoldKey;

/** Latch: this account has written the fragmented list at least once. */
const seedKeyOf = (pubkey: string) => `concord2-list-seeded:${pubkey}`;

type NostrLike = {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]>;
  group?(relays: string[]): { query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> };
  relay?(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]>;
    event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown>;
  };
  event?(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown>;
};

/** Decode-once memo for fragment decrypts, keyed by event id. */
const fragDecryptMemo = new Map<string, Promise<FragList | null>>();

function dTagOf(event: NostrRumor): string | undefined {
  return event.tags.find((t) => t[0] === "d")?.[1];
}

/** The fragment index off the `d` tag — a bare decimal, or the event is not a fragment. */
function fragIndexOf(event: NostrRumor): number | undefined {
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
  fragDecryptMemo.set(event.id, work);
  return work;
}

/**
 * What a fragment fetch found: the unioned list, and each index's `created_at`
 * so the next write to that fragment can exceed it.
 */
export interface FragSet {
  list: CommunityList;
  /** Per read index, the winning fragment's created_at. */
  createdAt: Map<number, number>;
  /** `frags` as declared by the newest fragment seen (age tie → larger). */
  declared: number;
  /**
   * The winning parsed fragment per index — what the relays currently hold,
   * so a rewrite can skip publishing byte-identical fragments.
   */
  readFrags: Map<number, FragList>;
  /** The newest winning fragment event (for cache identity / logging). */
  newestEvent: NostrRumor | null;
  /** Coverage, not agreement: an index at every slot below `declared`. */
  complete: boolean;
}

/**
 * Fetch the account's 33302 fragments and union them. Reads the pool AND the
 * stock CORD relays: the publish below falls back to the stock set when the
 * user's own relays refuse the kind, so part of the set may live only there.
 * Returns `null` when no fragment events exist anywhere reachable, and
 * `{ set: undefined }`-like "no news" (all-unreadable) via `unreadable`.
 */
async function fetchFragments(
  nostr: NostrLike,
  user: NUser,
  signal?: AbortSignal,
): Promise<{ set: FragSet | null; unreadable: boolean }> {
  const listFilter: NostrFilter[] = [
    { kinds: [KIND_COMMUNITY_LIST_FRAG], authors: [user.pubkey], limit: 64 },
  ];
  const timeout = () => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)]);
  // The pool read is STRICT — a failed read must never drive a write built
  // without the remote copy (it would drop seed anchors and re-stamp add
  // times). The stock read stays best-effort: it is the rescue floor, and one
  // cold stock relay must not fail every sync.
  const [poolEvents, stockEvents] = await Promise.all([
    nostr.query(listFilter, { signal: timeout() }),
    nostr.group
      ? nostr.group([...STOCK_RELAYS]).query(listFilter, { signal: timeout() }).catch(() => [] as NostrRumor[])
      : Promise.resolve([] as NostrRumor[]),
  ]);
  const events = new Map<string, NostrRumor>();
  for (const e of [...poolEvents, ...stockEvents]) events.set(e.id, e);
  if (events.size === 0) return { set: null, unreadable: false };

  // Newest wins PER INDEX — each fragment is its own addressable coordinate,
  // so they age independently. Mirror relay resolution (CORD-02 §8): newest
  // created_at holds the coordinate, an age tie falls to the LOWEST event id.
  const newest = new Map<number, { at: number; id: string; frag: FragList; event: NostrRumor }>();
  for (const event of events.values()) {
    const index = fragIndexOf(event);
    if (index === undefined) continue; // not a fragment: no/junk `d`
    const frag = await decryptFragment(event, user.signer, user.pubkey);
    if (!frag) continue;
    const prev = newest.get(index);
    const wins = !prev || event.created_at > prev.at || (event.created_at === prev.at && event.id < prev.id);
    if (wins) newest.set(index, { at: event.created_at, id: event.id, frag, event });
  }
  if (newest.size === 0) {
    // Events exist but none yielded a fragment (undecryptable, unparseable, or
    // junk-tagged). "No news", never "empty": an empty verdict here would let
    // a bad signer state clobber the vault — and it must not seed either.
    logSync("list2", `${events.size} fragment event(s) fetched, none readable — treating as no news`);
    return { set: null, unreadable: true };
  }

  // The newest fragment governs `frags`; an age tie resolves to the LARGER
  // count — too large reads an index that turns out empty, too small sends
  // live fragments out of range and dormant.
  let declared = 1;
  let best: { at: number; frags: number } | undefined;
  for (const { at, frag } of newest.values()) {
    if (!best || at > best.at || (at === best.at && frag.frags > best.frags)) {
      best = { at, frags: frag.frags };
    }
  }
  if (best) declared = Math.max(best.frags, 1);

  const indices = [...newest.keys()].sort((a, b) => a - b);
  const readFrags = new Map<number, FragList>(indices.map((i) => [i, newest.get(i)!.frag]));
  const createdAt = new Map<number, number>(indices.map((i) => [i, newest.get(i)!.at]));
  const complete = Array.from({ length: declared }, (_, i) => i).every((i) => createdAt.has(i));
  const newestEvent = [...newest.values()].reduce<NostrRumor | null>(
    (a, b) => (a && a.created_at >= b.event.created_at ? a : b.event),
    null,
  );
  if (!complete) {
    logSync("list2", `INCOMPLETE: hold ${createdAt.size} of ${declared} fragment(s) — reading, refusing to write`);
  }
  return {
    set: { list: defragment(indices.map((i) => readFrags.get(i)!)), createdAt, declared, readFrags, newestEvent, complete },
    unreadable: false,
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
): Promise<NostrRumor | null> {
  if (!user.signer.nip44) throw new Error("NIP-44 encryption not supported by this signer");
  const frags = fragment(list);
  const now = Math.floor(Date.now() / 1000);
  const unchanged = (index: number, frag: FragList): boolean => {
    const old = readFrags.get(index);
    return old !== undefined && serializeFragList(old) === serializeFragList(frag);
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
  const publishOne = async (frag: FragList, index: number) => {
    const createdAt = Math.max(now, (prevCreatedAt.get(index) ?? 0) + 1);
    const plaintext = serializeFragList(frag);
    const content = await user.signer.nip44!.encrypt(user.pubkey, plaintext);
    const event = await user.signer.signEvent({
      kind: KIND_COMMUNITY_LIST_FRAG,
      content,
      tags: [["d", String(index)]],
      created_at: createdAt,
    });
    try {
      await nostr.event!(event, { signal: AbortSignal.timeout(8000) });
    } catch {
      // The pool publish needs only ONE configured relay to accept, but a
      // user whose relays all refuse kind 33302 (kind whitelists, auth
      // gates, outages) would strand every create/join here. The list is the
      // vault, so fall back to the stock CORD relays, which are write-open
      // for Concord kinds.
      const results = await Promise.allSettled(
        STOCK_RELAYS.map((url) => nostr.relay!(url).event(event, { signal: AbortSignal.timeout(8000) })),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        logSync("list2", `fragment ${index} publish FAILED — no relay accepted it`);
        throw new Error("No relay accepted your community list update.");
      }
    }
    if (!newest || event.created_at >= newest.created_at) newest = event;
  };

  for (let index = 0; index < frags.length; index++) {
    if (unchanged(index, frags[index])) {
      skipped++;
      continue;
    }
    await publishOne(frags[index], index);
  }
  for (let index = frags.length; index < prevCreatedAt.size; index++) {
    const empty = emptyFragList(frags.length);
    if (unchanged(index, empty)) {
      skipped++;
      continue;
    }
    await publishOne(empty, index);
  }
  if (skipped > 0) {
    logSync("list2", `${skipped} fragment(s) skipped — byte-identical to the relay copy`);
  }
  return newest;
}

/**
 * Whether publishing `frags` would change what the relays hold: some rebuilt
 * fragment differs byte-wise from the wire copy at its index, or an index the
 * wire holds beyond the rebuilt set isn't already the matching empty List.
 * Exactly the writes {@link publishFragments} would NOT skip.
 */
function wireDiffers(frags: FragList[], read: Map<number, FragList>, readCount: number): boolean {
  for (let i = 0; i < frags.length; i++) {
    const old = read.get(i);
    if (!old || serializeFragList(old) !== serializeFragList(frags[i])) return true;
  }
  const empty = serializeFragList(emptyFragList(frags.length));
  for (let i = frags.length; i < readCount; i++) {
    const old = read.get(i);
    if (!old || serializeFragList(old) !== empty) return true;
  }
  return false;
}

/**
 * Every relay answered EOSE with zero fragments — the only reading of "empty"
 * strong enough to seed over. The aggregate fetch that precedes this cannot
 * distinguish "no fragments" from "the relay holding them never answered";
 * asked one at a time, an error is a FAILED read and a failed read never seeds.
 */
async function confirmedNoFragments(nostr: NostrLike, pubkey: string, relays: string[]): Promise<boolean> {
  if (relays.length === 0 || !nostr.relay) return false;
  const filter: NostrFilter[] = [{ kinds: [KIND_COMMUNITY_LIST_FRAG], authors: [pubkey], limit: 1 }];
  for (const url of relays) {
    try {
      const events = await nostr.relay(url).query(filter, { signal: AbortSignal.timeout(8000) });
      if (events.length > 0) return false;
    } catch {
      return false;
    }
  }
  return true;
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
  if (await readFolded<boolean>(seedKeyOf(user.pubkey))) return;
  const cached = queryClient.getQueryData<ListData>(listQueryKey(user.pubkey));
  const local = cached?.list ?? (await readFolded<PersistedList>(foldKeyOf(user.pubkey)))?.list;
  if (!local || (local.entries.length === 0 && local.tombstones.length === 0)) return;

  const confirm = [...new Set([...(selfRelays.length > 0 ? selfRelays : []), ...STOCK_RELAYS])];
  if (!(await confirmedNoFragments(nostr, user.pubkey, confirm))) {
    logSync("list2", "seed DEFERRED — the empty read is unconfirmed; retrying on a later sync");
    return;
  }
  logSync("list2", "no fragments held anywhere (confirmed per relay) — seeding from local state");
  try {
    const newest = await publishFragments(nostr, user, local, new Map(), new Map());
    await writeFolded(seedKeyOf(user.pubkey), true);
    if (newest) {
      queryClient.setQueryData<ListData>(listQueryKey(user.pubkey), { event: newest, list: local });
    }
  } catch (err) {
    logSync("list2", `seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
): Promise<ListData> {
  const queryKey = listQueryKey(user.pubkey);
  const prev = queryClient.getQueryData<ListData>(queryKey);
  const { set, unreadable } = await fetchFragments(nostr, user, signal);

  if (!set) {
    if (unreadable) {
      // Never let an undecryptable read clobber a populated list (the keys
      // live here; a wrongful empty would vanish the rooms).
      return prev ?? { event: null, list: EMPTY_COMMUNITY_LIST, decryptFailed: true };
    }
    logSync("list2", "relay fetch: no fragments");
    if (selfRelays) await seedCommunityList(nostr, user, queryClient, selfRelays);
    return (
      queryClient.getQueryData<ListData>(queryKey) ?? prev ?? { event: null, list: EMPTY_COMMUNITY_LIST }
    );
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
  const merged = local ? mergeCommunityLists(local, set.list) : set.list;
  const next: ListData = { event: set.newestEvent, list: merged, decryptFailed: false };
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
  if (selfRelays && set.complete && user.signer.nip44) {
    try {
      const rebuilt = fragment(merged);
      if (wireDiffers(rebuilt, set.readFrags, set.createdAt.size)) {
        logSync("list2", "reconcile: the union knows more than the wire — publishing it");
        const newest = await publishFragments(nostr, user, merged, set.createdAt, set.readFrags);
        void writeFolded(seedKeyOf(user.pubkey), true);
        if (newest) next.event = newest;
      }
    } catch (err) {
      // Non-fatal: the read side of this sync already succeeded, and the
      // reconcile re-arms on every later sync until it lands.
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
      }
      void writeFolded(foldKey, { event: newestEvent, list } satisfies PersistedList);
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
    queryFn: ({ signal }) =>
      syncCommunityList(nostr, user!, queryClient, signal, selfStateRelays(config, user!.pubkey)),
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

export function useUpdateCommunityList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const removeRailKey = useRemoveRailKey();

  return useMutation({
    // Serialize every list mutation onto one queue so back-to-back joins can't
    // interleave read-modify-writes and drop each other's entries.
    scope: { id: "concord-list" },
    mutationFn: async (action: CommunityListAction) => {
      if (!user) throw new Error("User is not logged in");
      if (!user.signer.nip44) throw new Error("NIP-44 encryption not supported by this signer");

      // Read-modify-write against fresh relay state (pool + the stock CORD
      // relays, where the publish fallback may have put the newest copy).
      const { set, unreadable } = await fetchFragments(nostr, user);
      if (unreadable) {
        throw new Error(
          "Couldn't read your existing communities (decryption failed); not saving to avoid losing room keys.",
        );
      }
      if (set && !set.complete) {
        // Rewriting a set we haven't fully read would drop the memberships in
        // the fragments we're missing — CORD-02 §8's one write refusal.
        throw new Error(
          `Holding ${set.createdAt.size} of ${set.declared} community-list fragments; try again once the missing ones sync.`,
        );
      }
      const relayList = set?.list ?? EMPTY_COMMUNITY_LIST;

      // Fold in the local optimistic cache (addressable propagation lags).
      const cached = queryClient.getQueryData<ListData>(listQueryKey(user.pubkey));
      const current = cached ? mergeCommunityLists(cached.list, relayList) : relayList;
      const next = applyAction(current, action);

      // No whole-list cap and no plaintext gate: fragmentation is what keeps
      // each event publishable (CORD-02 §8), and a strictly-shrinking write
      // must never be blocked — leaving is what restores compliance.
      const newest = await publishFragments(
        nostr,
        user,
        next,
        set?.createdAt ?? new Map(),
        set?.readFrags ?? new Map(),
      );

      const event = newest ?? set?.newestEvent ?? cached?.event ?? null;
      queryClient.setQueryData<ListData>(listQueryKey(user.pubkey), { event, list: next });
      void writeFolded(foldKeyOf(user.pubkey), { event, list: next } satisfies PersistedList);
      // A successful write IS the proof the account speaks §8 — latch the
      // seed so a later empty boot-read can't republish over siblings.
      void writeFolded(seedKeyOf(user.pubkey), true);
      return next;
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

import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { fetchRelayInfoDoc, useRelayInfo } from "@/hooks/useRelayInfo";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import {
  buildRelayGroups,
  KIND_GROUP_METADATA,
  KIND_PUT_USER,
  reconcileRelayGroups,
  relayGroupCacheFilters,
} from "@/lib/nip29";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * How long the channel-list query waits for the NIP-11 doc (for the relay's
 * signing key) before querying without the `authors` filter. On a first visit
 * the doc usually resolves in one HTTP round-trip well inside this; a slow or
 * broken NIP-11 endpoint must not hold the whole channel list hostage (it used
 * to gate `enabled`, serializing NIP-11's full 8s timeout in front of the
 * channel skeleton). When the key arrives after an unfiltered fetch, the query
 * refetches once with the filter applied (see below).
 */
const NIP11_RACE_MS = 2_000;

/**
 * Fetch all groups hosted on a server (relay).
 *
 * Group metadata events (kind 39000) MUST be signed by the relay's own key.
 * When the relay advertises that key via NIP-11 (`self` or `pubkey`), the
 * query filters by `authors` so forged metadata from other publishers is
 * never trusted.
 *
 * Relays may hide closed/private groups from open-ended listings, so the
 * ids remembered in the user's kind 10009 list are queried explicitly by
 * `d` tag and merged in.
 *
 * That kind-10009 recovery isn't enough for users arriving from Flotilla:
 * Flotilla's "join" only publishes a kind-9021 to the relay and NEVER writes a
 * `group` tag into kind-10009 (that tag is only its per-room "favorite"
 * toggle). So a Flotilla member of a closed/private channel has nothing in
 * their 10009 list to recover it by, and the relay hides it from the open
 * listing — the channel silently disappears on migration. To match what
 * Flotilla showed, we ALSO enumerate the user's memberships directly from the
 * relay via kind-9000 (put-user) events tagging them (`#p`), then fetch the
 * kind-39000 metadata for those group ids by `#d` and merge it in. This is
 * membership-scoped, so it never surfaces channels the user has no access to.
 *
 * The channel list is one of the most STABLE things in the app: it's
 * relay-signed metadata that changes only when an admin creates/edits/deletes
 * a channel. So this query is deliberately quiet — no polling, a long
 * staleTime, an IndexedDB seed so it renders instantly on reload, and explicit
 * invalidation (see useGroupModeration / useCreateGroup) for the rare real
 * changes. The query KEY is just the relay URL: `relaySelf` and the remembered
 * ids are read inside the queryFn for filtering, but kept OUT of the key so a
 * resolving NIP-11 doc or a churning kind-10009 list can't swap the cache
 * entry and force a refetch from scratch.
 */
export function useRelayGroups(relayUrl: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { user } = useCurrentUser();
  const { data: relayInfo, isLoading: infoLoading, isError: infoError } = useRelayInfo(relayUrl);
  const { data: userList } = useUserGroupList();

  const selfPubkey = user?.pubkey;
  const relaySelf = relayInfo?.self || relayInfo?.pubkey;
  const rememberedIds = (userList?.groups ?? [])
    .filter((ref) => ref.relay === relayUrl)
    .map((ref) => ref.id)
    .sort();

  const queryKey = ["nip29", "groups", relayUrl, selfPubkey ?? null];

  // Read THIS relay's cached kind-39000 metadata out of THIS relay's tenant.
  //
  // The scope is the tenant, and that is the whole point: author-scoping cannot
  // isolate relays that share a signing key — zooid ships a shared relay
  // identity, so two servers advertise the same NIP-11 pubkey and their channels
  // would otherwise bleed into each other (phantom rooms that "don't exist" when
  // opened), while kind 39000 being addressable meant their metadata replaced
  // one another outright. Storing per relay makes the isolation structural, so
  // this is an ordinary read with no side-table of provenance to consult and no
  // post-filter that can silently return nothing when that table is cold.
  async function readScopedCache(selfKey: string | undefined): Promise<NostrRumor[]> {
    const filters = relayGroupCacheFilters(selfKey, rememberedIds);
    if (filters.length === 0) return [];
    const store = await eventStore;
    return store.query(filters, { relay: relayUrl });
  }

  // Cache-first seed: hydrate the channel list from the store (where the relay's
  // kind-39000 metadata is persisted by NostrBatcher) so it renders instantly on
  // a fresh mount/reload instead of going blank while the relay round-trips.
  // Reads come from THIS relay's tenant, so one server's channels can never
  // bleed into another's — even when relays share a signing key.
  useEffect(() => {
    if (!relayUrl) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;
      const cached = await readScopedCache(relaySelf);
      if (cancelled || cached.length === 0) return;
      if (queryClient.getQueryData(queryKey)) return;
      queryClient.setQueryData(queryKey, buildRelayGroups(cached, relayUrl));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, relaySelf, rememberedIds.join(","), eventStore, queryClient]);

  // Whether the most recent queryFn run had the relay's signing key for the
  // `authors` filter. When the NIP-11 doc resolves only AFTER an unfiltered
  // fetch, we refetch once so forged metadata from other publishers is dropped.
  const fetchedWithSelfRef = useRef(false);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      // Resolve the relay's signing key WITHOUT gating on the NIP-11 query's
      // lifecycle: use it if already resolved, otherwise race a direct fetch
      // for a bounded beat. A relay with a broken NIP-11 endpoint costs at
      // most NIP11_RACE_MS here instead of blocking the channel list for the
      // full doc timeout.
      let selfKey = relaySelf;
      if (!selfKey) {
        const info = await Promise.race([
          fetchRelayInfoDoc(relayUrl!, signal).catch(() => undefined),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), NIP11_RACE_MS)),
        ]);
        selfKey = info?.self || info?.pubkey;
      }
      fetchedWithSelfRef.current = Boolean(selfKey);

      const authors = selfKey ? { authors: [selfKey] } : {};
      const filters: NostrFilter[] = [
        { kinds: [KIND_GROUP_METADATA], ...authors, limit: 500 },
      ];
      if (rememberedIds.length > 0) {
        filters.push({ kinds: [KIND_GROUP_METADATA], "#d": rememberedIds, ...authors });
      }

      const events = await nostr.relay(relayUrl!).query(filters, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });

      // Recover channels the user is a MEMBER of but the relay hides from the
      // open listing above (closed/private groups) and that aren't in their
      // kind-10009 list. This is the Flotilla-migration case: Flotilla joins
      // publish only a kind-9021 and never touch kind-10009, so a member of a
      // closed channel has nothing to recover it by. Enumerate memberships from
      // the relay's kind-9000 (put-user) roster events tagging this user, then
      // fetch the kind-39000 metadata for those group ids by `#d`. Membership-
      // scoped, so it can never surface a channel the user has no access to.
      const known = new Set(events.map((e) => e.tags.find(([n]) => n === "d")?.[1]));
      const memberEvents = selfPubkey
        ? await nostr
            .relay(relayUrl!)
            .query([{ kinds: [KIND_PUT_USER], "#p": [selfPubkey], limit: 500 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [])
        : [];
      const memberGroupIds = [
        ...new Set(
          memberEvents
            .flatMap((e) => e.tags.filter(([n]) => n === "h").map(([, id]) => id))
            .filter((id): id is string => Boolean(id) && !known.has(id)),
        ),
      ];
      const memberMeta = memberGroupIds.length
        ? await nostr
            .relay(relayUrl!)
            .query([{ kinds: [KIND_GROUP_METADATA], "#d": memberGroupIds, ...authors }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [])
        : [];

      // Reconcile with this relay's cached metadata. A read that ANSWERED is
      // authoritative: cached channels it no longer lists were left, deleted or
      // made private, and are pruned from the tenant so they can't union back
      // in on the next "Refresh channels" (the leave hook prunes its own row;
      // this covers removals the user didn't make from Armada). An EMPTY read
      // keeps the cache as the floor — it is indistinguishable from a cold
      // pool, an AUTH gate or a timeout. The cache being read is this relay's
      // own tenant, so same-key relays still can't bleed into each other; the
      // fresh events land in that tenant on the way through NostrBatcher.
      const cached = await readScopedCache(selfKey);
      const { groups, stale } = reconcileRelayGroups(cached, [...events, ...memberMeta], relayUrl!);
      if (stale.length > 0) {
        try {
          const store = await eventStore;
          await store.remove([{ kinds: [KIND_GROUP_METADATA], "#d": stale }], { relay: relayUrl });
        } catch {
          // Best-effort: a surviving row is only a cache entry the next
          // answered read re-decides.
        }
      }
      return groups;
    },
    enabled: Boolean(relayUrl),
    // Relay-signed, rarely-changing data. Keep it fresh for the whole session
    // and rely on explicit invalidation for the rare real change.
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  // The remembered ids (private/closed channels from the kind-10009 list) are
  // not part of the query key — that list churns constantly and we don't want it
  // swapping the cache entry. But if the user joins a channel the open listing
  // hides, its id won't be in the current result; refetch ONCE in that case so
  // the newly-joined channel shows up. Steady state (every remembered id already
  // present) stays quiet.
  const data = query.data;
  useEffect(() => {
    if (!relayUrl || !data) return;
    const known = new Set(data.map((g) => g.id));
    if (rememberedIds.some((id) => !known.has(id))) {
      void query.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, data, rememberedIds.join(",")]);

  // If the current data was fetched WITHOUT the relay's signing key (NIP-11
  // hadn't resolved inside the race window), refetch once when the key lands so
  // the `authors` filter re-applies and forged metadata can't linger for the
  // hour-long staleTime.
  useEffect(() => {
    if (!relayUrl || !relaySelf || !data) return;
    if (!fetchedWithSelfRef.current) {
      fetchedWithSelfRef.current = true;
      void query.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, relaySelf, data]);

  // While the NIP-11 info doc is still loading AND we have no channel data yet,
  // surface that as "loading" — otherwise a stuck/slow info fetch would read as
  // a non-loading, empty result. But once we have groups (live or seeded from
  // IndexedDB), a slow/failed NIP-11 fetch must NOT mark the channel list as
  // loading/errored: the channel list is its own stable thing and shouldn't
  // blank just because the relay's name/avatar fetch hiccuped on a shaky
  // connection. So info state only matters when there's no group data at all.
  const haveGroups = Boolean(query.data);
  const isLoading = query.isLoading || (infoLoading && !haveGroups);
  const isError = query.isError || (infoError && !haveGroups);

  return { ...query, isLoading, isError, relayInfo };
}

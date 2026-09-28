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
 * Max wait for NIP-11 (the signing key) before querying without `authors`; a slow NIP-11 must
 * not gate the channel list. A late key triggers one filtered refetch.
 */
const NIP11_RACE_MS = 2_000;

/**
 * All groups on a relay. Kind 39000 must be signed by the relay's own key (NIP-11 `self`/
 * `pubkey`), filtered via `authors` when known. Hidden groups are recovered by `d` from the kind
 * 10009 list and from the relay's kind-9000 roster events tagging the user (Flotilla joins never write
 * 10009). Deliberately quiet: no polling, long staleTime, IndexedDB seed, explicit invalidation. The
 * key is only the relay URL, so NIP-11 or 10009 churn can't swap the entry.
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

  // Per-relay tenant: relays sharing a signing key (zooid) would otherwise bleed channels into
  // each other, and addressable 39000s would replace one another.
  async function readScopedCache(selfKey: string | undefined): Promise<NostrRumor[]> {
    const filters = relayGroupCacheFilters(selfKey, rememberedIds);
    if (filters.length === 0) return [];
    const store = await eventStore;
    return store.query(filters, { relay: relayUrl });
  }

  // Cache-first seed from THIS relay's tenant so the list renders instantly on reload.
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

  // Whether the last fetch had the signing key; if not, refetch once when it lands.
  const fetchedWithSelfRef = useRef(false);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      // Don't gate on the NIP-11 query: use the key if resolved, else race a fetch for NIP11_RACE_MS.
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

      // Recover hidden channels the user is a member of via kind-9000 roster events (Flotilla case).
      // Membership-scoped, so no inaccessible channels surface.
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

      // An answered read is authoritative: prune cached channels it no longer lists. An EMPTY read
      // keeps the cache (indistinguishable from an outage).
      const cached = await readScopedCache(selfKey);
      const { groups, stale } = reconcileRelayGroups(cached, [...events, ...memberMeta], relayUrl!);
      if (stale.length > 0) {
        try {
          const store = await eventStore;
          await store.remove([{ kinds: [KIND_GROUP_METADATA], "#d": stale }], { relay: relayUrl });
        } catch {
          // Best-effort: the next answered read re-decides a surviving row.
        }
      }
      return groups;
    },
    enabled: Boolean(relayUrl),
    // Relay-signed, rarely-changing; rely on explicit invalidation.
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  // Remembered ids aren't in the key; refetch ONCE if one is missing from the result (e.g. a
  // newly-joined hidden channel).
  const data = query.data;
  useEffect(() => {
    if (!relayUrl || !data) return;
    const known = new Set(data.map((g) => g.id));
    if (rememberedIds.some((id) => !known.has(id))) {
      void query.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, data, rememberedIds.join(",")]);

  // Fetched without the signing key: refetch when it lands so forged metadata can't linger.
  useEffect(() => {
    if (!relayUrl || !relaySelf || !data) return;
    if (!fetchedWithSelfRef.current) {
      fetchedWithSelfRef.current = true;
      void query.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, relaySelf, data]);

  // NIP-11 loading only counts as loading when there's no group data at all.
  const haveGroups = Boolean(query.data);
  const isLoading = query.isLoading || (infoLoading && !haveGroups);
  const isError = query.isError || (infoError && !haveGroups);

  return { ...query, isLoading, isError, relayInfo };
}

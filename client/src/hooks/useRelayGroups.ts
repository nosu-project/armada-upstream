import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useRelayInfo } from "@/hooks/useRelayInfo";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { KIND_GROUP_METADATA, parseGroupMetadata, type Nip29Group } from "@/lib/nip29";

import type { NostrFilter } from "@nostrify/nostrify";

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
 */
export function useRelayGroups(relayUrl: string | undefined) {
  const { nostr } = useNostr();
  const { data: relayInfo, isLoading: infoLoading } = useRelayInfo(relayUrl);
  const { data: userList } = useUserGroupList();

  const relaySelf = relayInfo?.self || relayInfo?.pubkey;
  const rememberedIds = (userList?.groups ?? [])
    .filter((ref) => ref.relay === relayUrl)
    .map((ref) => ref.id)
    .sort();

  const query = useQuery({
    queryKey: ["nip29", "groups", relayUrl, relaySelf ?? "any", rememberedIds.join(",")],
    queryFn: async ({ signal }) => {
      const authors = relaySelf ? { authors: [relaySelf] } : {};
      const filters: NostrFilter[] = [
        { kinds: [KIND_GROUP_METADATA], ...authors, limit: 500 },
      ];
      if (rememberedIds.length > 0) {
        filters.push({ kinds: [KIND_GROUP_METADATA], "#d": rememberedIds, ...authors });
      }

      const events = await nostr.relay(relayUrl!).query(filters, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });

      const groups = new Map<string, Nip29Group>();
      for (const event of events) {
        const group = parseGroupMetadata(event, relayUrl!);
        if (!group) continue;
        const existing = groups.get(group.id);
        if (!existing || existing.event.created_at < event.created_at) {
          groups.set(group.id, group);
        }
      }

      return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    enabled: Boolean(relayUrl) && !infoLoading,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  return { ...query, relayInfo };
}

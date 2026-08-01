import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import {
  KIND_GROUP_ADMINS,
  KIND_GROUP_MEMBERS,
  KIND_GROUP_METADATA,
  KIND_GROUP_ROLES,
  parseGroupAdmins,
  parseGroupMemberRoles,
  parseGroupMembers,
  parseGroupMetadata,
  parseGroupRoles,
  type Nip29Admin,
  type Nip29Group,
  type Nip29Role,
} from "@/lib/nip29";

import type { NostrRumor } from "@/lib/nostrRumor";

export interface GroupDetails {
  group: Nip29Group | undefined;
  admins: Nip29Admin[];
  members: string[];
  /** Per-member role labels (Buzz: owner/admin/member/guest/bot). */
  memberRoles: Record<string, string>;
  roles: Nip29Role[];
}

const GROUP_KINDS = [KIND_GROUP_METADATA, KIND_GROUP_ADMINS, KIND_GROUP_MEMBERS, KIND_GROUP_ROLES];

/** Compose GroupDetails from a set of 39000-39003 events (newest per kind wins). */
function composeGroupDetails(events: NostrRumor[], relayUrl: string): GroupDetails {
  const newest = new Map<number, NostrRumor>();
  for (const event of events) {
    const existing = newest.get(event.kind);
    if (!existing || existing.created_at < event.created_at) {
      newest.set(event.kind, event);
    }
  }
  const metadataEvent = newest.get(KIND_GROUP_METADATA);
  const adminsEvent = newest.get(KIND_GROUP_ADMINS);
  const membersEvent = newest.get(KIND_GROUP_MEMBERS);
  const rolesEvent = newest.get(KIND_GROUP_ROLES);
  return {
    group: metadataEvent ? parseGroupMetadata(metadataEvent, relayUrl) : undefined,
    admins: adminsEvent ? parseGroupAdmins(adminsEvent) : [],
    members: membersEvent ? parseGroupMembers(membersEvent) : [],
    memberRoles: membersEvent ? parseGroupMemberRoles(membersEvent) : {},
    roles: rolesEvent ? parseGroupRoles(rolesEvent) : [],
  };
}

/**
 * Fetch a single group's relay-signed state (metadata, admins, members,
 * roles). LOCAL-FIRST: the 39000-39003 events are plaintext and mirrored into
 * IndexedDB by NostrBatcher, so a group we've opened renders its member/admin
 * list instantly from cache on reload — the relay refresh happens in the
 * background and never gates the visible roster.
 */
export function useGroup(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const { data: relayInfo } = useRelayInfo(relayUrl);

  const relaySelf = relayInfo?.self || relayInfo?.pubkey;
  const queryKey = ["nip29", "group", relayUrl, groupId];

  return useQuery<GroupDetails>({
    queryKey,
    queryFn: async ({ signal }) => {
      const store = await eventStore;

      // 1. LOCAL-FIRST: cached 39000-39003 for this group → instant roster.
      const cached = await store.query([{ kinds: GROUP_KINDS, "#d": [groupId!] }]);
      const local = composeGroupDetails(cached, relayUrl!);

      // 2. BACKGROUND refresh from the host relay (mirrored back into the store).
      //    Not awaited — the network never gates the visible member list.
      void (async () => {
        if (signal.aborted) return;
        try {
          const events = await nostr.relay(relayUrl!).query(
            [{
              kinds: GROUP_KINDS,
              "#d": [groupId!],
              ...(relaySelf ? { authors: [relaySelf] } : {}),
            }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
          );
          if (signal.aborted || events.length === 0) return;
          queryClient.setQueryData<GroupDetails>(queryKey, composeGroupDetails(events, relayUrl!));
        } catch {
          // Best-effort; the local-first roster already rendered.
        }
      })();

      return local;
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

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

/** Newest per kind wins. */
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
 * A group's relay-signed state (39000-39003). Local-first from IndexedDB; the relay refresh
 * never gates the roster.
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

      // Scoped to THIS relay's tenant: some relay software shares one identity across servers, so
      // kind+pubkey+`d` isn't unique.
      const cached = await store.query([{ kinds: GROUP_KINDS, "#d": [groupId!] }], {
        relay: relayUrl,
      });
      const local = composeGroupDetails(cached, relayUrl!);

      // Background refresh; never awaited.
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

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useRelayInfo } from "@/hooks/useRelayInfo";
import {
  KIND_GROUP_ADMINS,
  KIND_GROUP_MEMBERS,
  KIND_GROUP_METADATA,
  KIND_GROUP_ROLES,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
  parseGroupAdmins,
  parseGroupMetadata,
  parseGroupRoles,
  resolveGroupMembers,
  type Nip29Admin,
  type Nip29Group,
  type Nip29Role,
} from "@/lib/nip29";

export interface GroupDetails {
  group: Nip29Group | undefined;
  admins: Nip29Admin[];
  members: string[];
  roles: Nip29Role[];
}

/**
 * Fetch a single group's relay-signed state (metadata, admins, members,
 * roles) in one query against the host relay.
 */
export function useGroup(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const { data: relayInfo, isLoading: infoLoading } = useRelayInfo(relayUrl);

  const relaySelf = relayInfo?.self || relayInfo?.pubkey;

  return useQuery<GroupDetails>({
    queryKey: ["nip29", "group", relayUrl, groupId, relaySelf ?? "any"],
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [
          {
            kinds: [KIND_GROUP_METADATA, KIND_GROUP_ADMINS, KIND_GROUP_MEMBERS, KIND_GROUP_ROLES],
            "#d": [groupId!],
            ...(relaySelf ? { authors: [relaySelf] } : {}),
          },
          // Live membership moderation events. The relay only regenerates its
          // kind 39002 members snapshot on changes, so fold these in to keep the
          // roster current (see resolveGroupMembers / Flotilla's getRoomMembers).
          {
            kinds: [KIND_PUT_USER, KIND_REMOVE_USER],
            "#h": [groupId!],
            limit: 500,
          },
        ],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );

      // Keep only the newest addressable/relay-signed event per kind.
      const newest = new Map<number, typeof events[number]>();
      const addRemoveEvents: typeof events = [];
      for (const event of events) {
        if (event.kind === KIND_PUT_USER || event.kind === KIND_REMOVE_USER) {
          addRemoveEvents.push(event);
          continue;
        }
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
        group: metadataEvent ? parseGroupMetadata(metadataEvent, relayUrl!) : undefined,
        admins: adminsEvent ? parseGroupAdmins(adminsEvent) : [],
        members: resolveGroupMembers(groupId!, membersEvent, addRemoveEvents),
        roles: rolesEvent ? parseGroupRoles(rolesEvent) : [],
      };
    },
    enabled: Boolean(relayUrl && groupId) && !infoLoading,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

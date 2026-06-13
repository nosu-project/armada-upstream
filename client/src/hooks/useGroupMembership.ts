import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import {
  KIND_JOIN_REQUEST,
  KIND_LEAVE_REQUEST,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
} from "@/lib/nip29";

/**
 * The current user's membership state in a group, per NIP-29: the latest of
 * kind 9000 (put-user) vs kind 9001 (remove-user) targeting the user decides.
 */
export function useGroupMembership(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useQuery({
    queryKey: ["nip29", "membership", relayUrl, groupId, user?.pubkey],
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{
          kinds: [KIND_PUT_USER, KIND_REMOVE_USER],
          "#h": [groupId!],
          "#p": [user!.pubkey],
          limit: 10,
        }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );

      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      return {
        isMember: latest?.kind === KIND_PUT_USER,
        latestEvent: latest ?? null,
      };
    },
    enabled: Boolean(relayUrl && groupId && user),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/** Send a kind 9021 join request to the group's host relay. */
export function useJoinGroup(relayUrl: string, groupId: string) {
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ code, reason }: { code?: string; reason?: string } = {}) => {
      const tags: string[][] = [["h", groupId]];
      if (code) tags.push(["code", code]);
      return publishEvent({
        kind: KIND_JOIN_REQUEST,
        content: reason ?? "",
        tags,
        relay: relayUrl,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nip29", "membership", relayUrl, groupId] });
      queryClient.invalidateQueries({ queryKey: ["nip29", "group", relayUrl, groupId] });
    },
  });
}

/** Send a kind 9022 leave request to the group's host relay. */
export function useLeaveGroup(relayUrl: string, groupId: string) {
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ reason }: { reason?: string } = {}) => {
      return publishEvent({
        kind: KIND_LEAVE_REQUEST,
        content: reason ?? "",
        tags: [["h", groupId]],
        relay: relayUrl,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nip29", "membership", relayUrl, groupId] });
      queryClient.invalidateQueries({ queryKey: ["nip29", "group", relayUrl, groupId] });
    },
  });
}

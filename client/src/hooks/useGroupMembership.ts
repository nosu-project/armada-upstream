import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useJoinRelay } from "@/hooks/useRelayMembership";
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
  const { mutateAsync: joinRelay } = useJoinRelay();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ code, reason }: { code?: string; reason?: string } = {}) => {
      // Some community relays (zooid/Coracle, used by Flotilla & Soapbox) gate
      // ALL writes behind *relay-level* membership and reject non-members with
      // "you are not a member of this relay" — before the NIP-29 group join is
      // even considered. So first attempt the relay-join handshake (ephemeral
      // kind 28934 carrying the invite as a `claim`). It's best-effort and never
      // throws: it no-ops on relays that don't implement the scheme (e.g.
      // Armada's own relay29, which rejects the unknown kind). The group join
      // below is the source of truth.
      await joinRelay({ relayUrl, claim: code });

      // Then the NIP-29 group join. The same invite is carried as a `code` tag
      // for relays that scope invites per-group (e.g. Armada's relay).
      const tags: string[][] = [["h", groupId]];
      if (code) tags.push(["code", code]);
      try {
        return await publishEvent({
          kind: KIND_JOIN_REQUEST,
          content: reason ?? "",
          tags,
          relay: relayUrl,
        });
      } catch (e) {
        // relay29 rejects a join from an existing member with "already a
        // member" — from the user's perspective that's success, not an error.
        const message = (e instanceof Error ? e.message : String(e)).toLowerCase();
        if (message.includes("already a member") || message.includes("already")) {
          return;
        }
        throw e;
      }
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

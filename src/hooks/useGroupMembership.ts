import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useJoinRelay } from "@/hooks/useRelayMembership";
import {
  KIND_GROUP_METADATA,
  KIND_JOIN_REQUEST,
  KIND_LEAVE_REQUEST,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
} from "@/lib/nip29";

/** NIP-29 membership: the latest of kind 9000 (put-user) vs 9001 (remove-user) decides. */
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
      // Some relays (zooid/Coracle) gate ALL writes on relay-level membership, so first try the
      // relay-join handshake (kind 28934 with the invite as `claim`). Best-effort and never throws; the
      // group join below is the source of truth.
      await joinRelay({ relayUrl, claim: code });

      // The invite also rides as `code` for relays that scope invites per group.
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
        // relay29's "already a member" is success from the user's perspective.
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
  const eventStore = useEventStore();

  return useMutation({
    mutationFn: async ({ reason }: { reason?: string } = {}) => {
      return publishEvent({
        kind: KIND_LEAVE_REQUEST,
        content: reason ?? "",
        tags: [["h", groupId]],
        relay: relayUrl,
      });
    },
    onSuccess: async () => {
      // Prune the cached kind-39000: useRelayGroups UNIONS cached 39000s with the live directory,
      // so a left channel would otherwise reappear on every refresh. Best-effort.
      try {
        const store = await eventStore;
        await store.remove([{ kinds: [KIND_GROUP_METADATA], "#d": [groupId] }], { relay: relayUrl });
      } catch {
        // Ignore — the invalidations below still run.
      }
      queryClient.invalidateQueries({ queryKey: ["nip29", "membership", relayUrl, groupId] });
      queryClient.invalidateQueries({ queryKey: ["nip29", "group", relayUrl, groupId] });
      queryClient.invalidateQueries({ queryKey: ["nip29", "groups", relayUrl] });
    },
  });
}

import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { KIND_USER_GROUPS, parseUserGroupList, type GroupRef } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * The user's kind 10009 group list (NIP-51), used as the "joined servers and
 * channels" memory across devices.
 */
export function useUserGroupList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useQuery({
    queryKey: ["nip29", "user-groups", user?.pubkey],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [KIND_USER_GROUPS], authors: [user!.pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      return {
        event: latest as NostrEvent | null,
        groups: latest ? parseUserGroupList(latest) : [],
      };
    },
    enabled: Boolean(user),
    staleTime: 30_000,
  });
}

/** Add or remove a group ref in the user's kind 10009 list (read-modify-write). */
export function useUpdateUserGroupList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ action, ref }: { action: "add" | "remove"; ref: GroupRef }) => {
      if (!user) throw new Error("User is not logged in");

      // Read-modify-write against fresh relay state, never the query cache.
      const events = await nostr.query(
        [{ kinds: [KIND_USER_GROUPS], authors: [user.pubkey], limit: 1 }],
        { signal: AbortSignal.timeout(8000) },
      );
      const prev = events.sort((a, b) => b.created_at - a.created_at)[0];

      const existing = prev ? parseUserGroupList(prev) : [];
      const without = existing.filter((g) => !(g.id === ref.id && g.relay === ref.relay));
      const next = action === "add" ? [...without, ref] : without;

      // Preserve any non-"group" tags from the previous list event.
      const otherTags = prev?.tags.filter(([name]) => name !== "group") ?? [];

      return publishEvent({
        kind: KIND_USER_GROUPS,
        content: prev?.content ?? "",
        tags: [
          ...otherTags,
          ...next.map((g) => ["group", g.id, g.relay]),
        ],
        prev: prev ?? undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nip29", "user-groups"] });
    },
  });
}

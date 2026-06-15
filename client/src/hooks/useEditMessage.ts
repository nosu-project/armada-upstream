import { useMutation } from "@tanstack/react-query";

import { useNostrPublish } from "@/hooks/useNostrPublish";
import { KIND_DELETE } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Edit a message the current user authored, NIP-09 style: delete the original
 * (kind 5) and republish a fresh event with the SAME `created_at` so the edit
 * keeps its place in the timeline. The relay enforces author-only deletion and
 * (via a kind-9 timestamp exemption) accepts the back-dated republish.
 *
 * The original tags are preserved (reply refs, mentions, imeta, etc.) except
 * for any prior `edited` marker; an `["edited", <unix>]` tag records the edit.
 * Returns the new event (with its new id) on success.
 */
export function useEditMessage(relayUrl: string, groupId: string) {
  const { mutateAsync: publish } = useNostrPublish();

  return useMutation<NostrEvent, Error, { original: NostrEvent; content: string }>({
    mutationFn: async ({ original, content }) => {
      const trimmed = content.trim();
      if (!trimmed) throw new Error("Message cannot be empty");
      if (trimmed === original.content.trim()) return original; // no-op

      // 1. Delete the original (NIP-09). The `h` tag routes/scopes it to the
      //    group; `k` records the deleted kind per NIP-09.
      await publish({
        kind: KIND_DELETE,
        content: "",
        tags: [
          ["e", original.id],
          ["k", String(original.kind)],
          ["h", groupId],
        ],
        relay: relayUrl,
      });

      // 2. Republish with the original timestamp + tags, swapping the content
      //    and stamping an `edited` marker.
      const tags = original.tags.filter(([name]) => name !== "edited");
      tags.push(["edited", String(Math.floor(Date.now() / 1000))]);

      const edited = await publish({
        kind: original.kind,
        content: trimmed,
        tags,
        created_at: original.created_at,
        relay: relayUrl,
      });

      return edited;
    },
  });
}

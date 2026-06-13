import { useNostr } from "@nostrify/react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { APP_NAME } from "@/lib/platform";
import { useCurrentUser } from "./useCurrentUser";

import type { NostrEvent } from "@nostrify/nostrify";

/** Event template accepted by `useNostrPublish`. */
export type EventTemplate = Omit<NostrEvent, "id" | "pubkey" | "sig" | "created_at"> & {
  created_at?: number;
  /**
   * The previous version of the event being replaced (for replaceable/addressable kinds).
   * When provided, `published_at` from the old event is preserved on the new one.
   */
  prev?: NostrEvent;
  /**
   * When set, publish only to this relay (NIP-29 group traffic must stay on
   * the group's host server). When omitted, the event goes to all configured
   * servers via the pool's eventRouter.
   */
  relay?: string;
};

/** Returns true if the kind falls in a replaceable or addressable range. */
function isReplaceableKind(kind: number): boolean {
  if (kind === 0 || kind === 3) return true;
  return (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000);
}

export function useNostrPublish(): UseMutationResult<NostrEvent, Error, EventTemplate> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async (t: EventTemplate) => {
      if (!user) {
        throw new Error("User is not logged in");
      }

      const { prev, relay, ...template } = t;
      const tags = [...(template.tags ?? [])];

      // NIP-89 client tag
      if (!tags.some(([name]) => name === "client")) {
        tags.push(["client", APP_NAME]);
      }

      const created_at = template.created_at ?? Math.floor(Date.now() / 1000);

      // published_at for replaceable/addressable events (NIP-24)
      if (isReplaceableKind(template.kind) && !tags.some(([name]) => name === "published_at")) {
        const oldTag = prev?.tags.find(([name]) => name === "published_at");
        if (oldTag) {
          tags.push(["published_at", oldTag[1]]);
        } else if (!prev) {
          tags.push(["published_at", String(created_at)]);
        }
      }

      const event = await user.signer.signEvent({
        kind: template.kind,
        content: template.content ?? "",
        tags,
        created_at,
      });

      if (event.pubkey !== user.pubkey) {
        throw new Error(
          "Signed event pubkey does not match the currently selected account. Please check your signer configuration.",
        );
      }

      if (relay) {
        await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(8000) });
      } else {
        await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      }

      return event;
    },
    onError: (error) => {
      console.error("Failed to publish event:", error);
    },
  });
}

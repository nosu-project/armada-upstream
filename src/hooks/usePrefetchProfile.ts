import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { followerCountQueryOptions, followingOfQueryOptions } from "@/hooks/useFollowStats";
import { profileBadgesQueryOptions } from "@/hooks/useProfileBadges";

/**
 * Warm what the profile overlay needs that the hovercard doesn't already fetch (badges, follow
 * counts). Hung off "View profile", not the hovercard trigger, so hovering avatars doesn't fan out.
 * Shares the owning hooks' query options so prefetch and mount fill one cache entry.
 */
export function usePrefetchProfile(): (pubkey: string) => void {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  return useCallback(
    (pubkey: string) => {
      if (!pubkey) return;
      // Separate calls: a loop would unify option types prefetchQuery can't infer. `enabled` is
      // stripped since prefetchQuery rejects it.
      const { enabled: _badges, ...badges } = profileBadgesQueryOptions(nostr, eventStore, pubkey);
      const { enabled: _following, ...following } = followingOfQueryOptions(nostr, eventStore, pubkey);
      const { enabled: _followers, ...followers } = followerCountQueryOptions(nostr, eventStore, pubkey);
      void queryClient.prefetchQuery(badges);
      void queryClient.prefetchQuery(following);
      void queryClient.prefetchQuery(followers);
    },
    [nostr, eventStore, queryClient],
  );
}

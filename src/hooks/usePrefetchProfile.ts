import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { followerCountQueryOptions, followingOfQueryOptions } from "@/hooks/useFollowStats";
import { profileBadgesQueryOptions } from "@/hooks/useProfileBadges";

/**
 * Warm the queries the profile overlay needs and nothing else already has.
 *
 * The hovercard a profile is usually opened from resolves the person's
 * metadata, theme, nsite, status and mute state on its own, so those are warm
 * by the time anyone clicks. What it never asks for is badges and follow
 * counts — which is exactly the set that is still arriving after the panel is
 * on screen.
 *
 * Deliberately hung off the "View profile" affordance rather than the
 * hovercard's own trigger (where `usePrefetchProfileTheme` sits): a theme is
 * one cheap replaceable event and the card itself wears it, while these are
 * three queries for a screen the viewer may never open. Hovering an avatar in
 * a busy channel must not fan out to that.
 *
 * Shares the owning hooks' query options, so a prefetch and the mount that
 * follows it fill one cache entry instead of racing two copies of the work.
 */
export function usePrefetchProfile(): (pubkey: string) => void {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  return useCallback(
    (pubkey: string) => {
      if (!pubkey) return;
      // Three separate calls rather than a loop: the option objects have
      // different result types, and a loop unifies them into a union that
      // prefetchQuery can't infer a data type from.
      // `enabled` is a useQuery concept prefetchQuery rejects, and the pubkey
      // it gated on is known non-empty here.
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

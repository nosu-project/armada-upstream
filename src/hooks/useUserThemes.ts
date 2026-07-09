import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { parseDittoTheme, THEME_DEFINITION_KIND, type DittoTheme } from "@/lib/themeEvent";

/**
 * The logged-in user's theme library (Ditto kind 36767 events), read from the
 * app relays. Lets themes created in Ditto appear in Armada's theme picker.
 * Deduplicated by d-tag identifier, newest first.
 */
export function useUserThemes() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useQuery<DittoTheme[]>({
    queryKey: ["user-themes", user?.pubkey],
    enabled: !!user?.pubkey,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      if (!user?.pubkey) return [];

      const events = await nostr.query(
        [{ kinds: [THEME_DEFINITION_KIND], authors: [user.pubkey], limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) },
      );

      // Newest event per d-tag wins.
      const latest = new Map<string, typeof events[number]>();
      for (const event of events) {
        const id = event.tags.find(([n]) => n === "d")?.[1] ?? event.id;
        const prev = latest.get(id);
        if (!prev || event.created_at > prev.created_at) latest.set(id, event);
      }

      return [...latest.values()]
        .sort((a, b) => b.created_at - a.created_at)
        .map(parseDittoTheme)
        .filter((t): t is DittoTheme => t !== null);
    },
  });
}

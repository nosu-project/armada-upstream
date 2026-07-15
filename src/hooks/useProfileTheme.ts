import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { ACTIVE_THEME_KIND, parseDittoTheme, type DittoTheme } from "@/lib/themeEvent";

/**
 * A given user's active Ditto profile theme (kind 16767), read from the app
 * relays. Lets us tint UI showing that person (e.g. the profile hovercard)
 * with the colors they chose in Ditto. Returns `undefined` when the user has
 * no theme (or it fails to parse).
 */
export function useProfileTheme(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<DittoTheme | null>({
    queryKey: ["profile-theme", pubkey],
    enabled: !!pubkey,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      if (!pubkey) return null;

      const events = await nostr.query(
        [{ kinds: [ACTIVE_THEME_KIND], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) },
      );

      // Replaceable kind: newest wins.
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      return latest ? parseDittoTheme(latest) : null;
    },
  });
}

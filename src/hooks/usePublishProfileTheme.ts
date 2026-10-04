import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { profileThemeQueryKey, type ProfileThemeResult } from "@/hooks/useProfileTheme";
import { fetchFreshEvent } from "@/lib/fetchFreshEvent";
import { isPublishQueuedError } from "@/lib/publishOutbox";
import {
  ACTIVE_THEME_KIND,
  buildActiveThemeEvent,
  buildClearActiveThemeEvent,
  type DittoTheme,
  type ThemeBackground,
  type ThemeFont,
} from "@/lib/themeEvent";
import { resolveThemeFontUrl } from "@/lib/themeFonts";

import type { CoreThemeColors, ThemeSource } from "@/themes";

export interface ProfileThemeInput {
  colors: CoreThemeColors;
  font?: ThemeFont;
  titleFont?: ThemeFont;
  background?: ThemeBackground;
  title?: string;
  description?: string;
  /** `a` coordinate of the kind-36767 definition this was applied from. */
  sourceRef?: string;
  /** The theme's original creator, credited with `a` + `p` tags. */
  source?: ThemeSource;
}

/** Tags the publisher adds rather than the theme. */
const BOOKKEEPING_TAGS = new Set(["client", "published_at"]);

/** Whether two kind-16767 tag lists describe the same theme, ignoring order and bookkeeping. */
function sameThemeTags(a: string[][], b: string[][]): boolean {
  const canonical = (tags: string[][]) => tags
    .filter(([name]) => !BOOKKEEPING_TAGS.has(name))
    .map((tag) => JSON.stringify(tag))
    .sort()
    .join("\n");
  return canonical(a) === canonical(b);
}

/**
 * Publish/clear the user's profile theme (kind 16767, as Ditto writes). Only from explicit
 * Save/Remove. Optimistically seeds the `useProfileTheme` cache. Saving the theme
 * already published signs nothing.
 */
export function usePublishProfileTheme() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent, isPending } = useNostrPublish();
  const queryClient = useQueryClient();

  const save = useCallback(
    async (input: ProfileThemeInput) => {
      if (!user) throw new Error("Not signed in");

      // Publish resolvable font URLs; title falls back to body (like Ditto's resolveThemeForPublishing).
      const withUrl = (f: ThemeFont | undefined): ThemeFont | undefined =>
        f?.family ? { family: f.family, url: resolveThemeFontUrl(f.family, f.url) } : undefined;
      const font = withUrl(input.font);
      const titleFont = withUrl(input.titleFont) ?? font;

      const optimistic: DittoTheme = {
        identifier: "",
        title: input.title || "Profile theme",
        colors: input.colors,
        font,
        titleFont,
        background: input.background,
        description: input.description,
        sourceRef: input.sourceRef,
        source: input.source,
      };
      const template = buildActiveThemeEvent(input.colors, {
        font,
        titleFont,
        background: input.background,
        title: input.title,
        description: input.description,
        sourceRef: input.sourceRef,
        source: input.source,
      });

      // Read-modify-write on a replaceable event: the cache can be stale.
      // Offline, fall back to the cached copy and let the outbox queue the publish.
      const fresh = await fetchFreshEvent(nostr, { kinds: [ACTIVE_THEME_KIND], authors: [user.pubkey] })
        .catch(() => null);
      if (fresh && sameThemeTags(fresh.tags, template.tags)) return;

      const prev = queryClient.getQueryData<ProfileThemeResult>(profileThemeQueryKey(user.pubkey));
      queryClient.setQueryData<ProfileThemeResult>(profileThemeQueryKey(user.pubkey), {
        event: prev?.event,
        theme: optimistic,
      });

      try {
        await publishEvent({ ...template, prev: fresh ?? prev?.event });
      } catch (e) {
        // A queued publish is signed and durable, so the optimistic tint stands.
        if (!isPublishQueuedError(e)) {
          queryClient.setQueryData(profileThemeQueryKey(user.pubkey), prev);
          throw e;
        }
      }
      void queryClient.invalidateQueries({ queryKey: profileThemeQueryKey(user.pubkey), refetchType: "none" });
    },
    [nostr, user, publishEvent, queryClient],
  );

  const remove = useCallback(async () => {
    if (!user) throw new Error("Not signed in");
    const prev = queryClient.getQueryData<ProfileThemeResult>(profileThemeQueryKey(user.pubkey));
    queryClient.setQueryData<ProfileThemeResult>(profileThemeQueryKey(user.pubkey), {});
    try {
      await publishEvent({ ...buildClearActiveThemeEvent(), prev: prev?.event });
    } catch (e) {
      if (!isPublishQueuedError(e)) {
        queryClient.setQueryData(profileThemeQueryKey(user.pubkey), prev);
        throw e;
      }
    }
    void queryClient.invalidateQueries({ queryKey: profileThemeQueryKey(user.pubkey), refetchType: "none" });
  }, [user, publishEvent, queryClient]);

  return { save, remove, isPending };
}

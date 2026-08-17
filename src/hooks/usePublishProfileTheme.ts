import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { profileThemeQueryKey, type ProfileThemeResult } from "@/hooks/useProfileTheme";
import { isPublishQueuedError } from "@/lib/publishOutbox";
import {
  buildActiveThemeEvent,
  buildClearActiveThemeEvent,
  type DittoTheme,
  type ThemeBackground,
  type ThemeFont,
} from "@/lib/themeEvent";
import { resolveThemeFontUrl } from "@/lib/themeFonts";

import type { CoreThemeColors } from "@/themes";

export interface ProfileThemeInput {
  colors: CoreThemeColors;
  font?: ThemeFont;
  titleFont?: ThemeFont;
  background?: ThemeBackground;
  title?: string;
  description?: string;
  /** `a` coordinate of the kind-36767 definition this was applied from. */
  sourceRef?: string;
}

/**
 * Publish / clear the user's active profile theme (kind 16767, the same event
 * Ditto writes). Only ever called from an explicit user action — the profile
 * theme editor's Save and Remove buttons. Optimistically seeds the
 * `useProfileTheme` cache so the page re-tints before the relay round-trip.
 */
export function usePublishProfileTheme() {
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent, isPending } = useNostrPublish();
  const queryClient = useQueryClient();

  const save = useCallback(
    async (input: ProfileThemeInput) => {
      if (!user) throw new Error("Not signed in");

      // Fonts publish with resolvable URLs: catalog families get their CDN
      // URL so clients without the catalog can load them; the title font
      // falls back to the body font so both tags are present whenever a body
      // font is (matching Ditto's resolveThemeForPublishing).
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
      };
      const prev = queryClient.getQueryData<ProfileThemeResult>(profileThemeQueryKey(user.pubkey));
      queryClient.setQueryData<ProfileThemeResult>(profileThemeQueryKey(user.pubkey), {
        event: prev?.event,
        theme: optimistic,
      });

      try {
        await publishEvent({
          ...buildActiveThemeEvent(input.colors, {
            font,
            titleFont,
            background: input.background,
            title: input.title,
            description: input.description,
            sourceRef: input.sourceRef,
          }),
          prev: prev?.event,
        });
      } catch (e) {
        // A queued publish is signed and durable; the retry worker lands it,
        // so the optimistic tint stands.
        if (!isPublishQueuedError(e)) {
          queryClient.setQueryData(profileThemeQueryKey(user.pubkey), prev);
          throw e;
        }
      }
      void queryClient.invalidateQueries({ queryKey: profileThemeQueryKey(user.pubkey), refetchType: "none" });
    },
    [user, publishEvent, queryClient],
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

import { useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { isPublishQueuedError } from "@/lib/publishOutbox";
import {
  buildThemeDefinitionEvent,
  buildThemeDeletionEvent,
  parseDittoTheme,
  type ThemeExtras,
} from "@/lib/themeEvent";

import type { NostrEvent } from "@nostrify/nostrify";
import type { UserTheme } from "@/hooks/useUserThemes";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { CoreThemeColors } from "@/themes";

/** A Discover page as `useDiscoverThemes` caches it; tests and older callers seed bare arrays. */
type DiscoverThemesData = NostrRumor[] | InfiniteData<{ events: NostrRumor[]; cursor?: number }>;

function addrOf(event: NostrRumor): string {
  const d = (event.tags ?? []).find(([n]) => n === "d")?.[1] ?? "";
  return `${event.kind}:${event.pubkey}:${d}`;
}

/**
 * Patch the cached Discover theme lists in place instead of refetching: an
 * immediate refetch races relay indexing and can return LESS than is on screen.
 * Inserts touch only the unsearched list, which the new theme is sure to match.
 */
function patchDiscoverThemes(
  queryClient: QueryClient,
  patch: (events: NostrRumor[], firstPage: boolean) => NostrRumor[],
  onlyUnsearched: boolean,
) {
  queryClient.setQueriesData<DiscoverThemesData>(
    {
      queryKey: ["discover", "themes"],
      predicate: (q) => !onlyUnsearched || q.queryKey[4] === "",
    },
    (prev) => {
      if (!prev) return prev;
      if (Array.isArray(prev)) return patch(prev, true);
      return {
        ...prev,
        pages: prev.pages.map((page, i) => ({ ...page, events: patch(page.events, i === 0) })),
      };
    },
  );
  void queryClient.invalidateQueries({ queryKey: ["discover", "themes"], refetchType: "none" });
}

function upsertUserTheme(queryClient: QueryClient, pubkey: string, event: NostrRumor) {
  const theme = parseDittoTheme(event);
  queryClient.setQueryData<UserTheme[]>(["user-themes", pubkey], (prev) => {
    if (!prev || !theme) return prev;
    return [{ ...theme, event }, ...prev.filter((t) => t.identifier !== theme.identifier)];
  });
  void queryClient.invalidateQueries({ queryKey: ["user-themes"], refetchType: "none" });
}

export interface PublishThemeInput extends ThemeExtras {
  title: string;
  colors: CoreThemeColors;
  /** The library entry being edited: keeps its `d` so the edit replaces it. */
  editing?: UserTheme;
}

/** Publish, edit and delete the user's kind-36767 themes. Explicit actions only. */
export function useThemeLibrary() {
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent, isPending } = useNostrPublish();
  const queryClient = useQueryClient();

  /** Resolves with the event and whether it is only queued (lands via the retry worker). */
  const publishTheme = useCallback(async (input: PublishThemeInput): Promise<{ event: NostrEvent; queued: boolean }> => {
    const { title, colors, editing, ...extras } = input;
    const template = buildThemeDefinitionEvent(title, colors, editing?.identifier, extras);

    let event: NostrEvent;
    let queued = false;
    try {
      event = await publishEvent({ ...template, prev: editing?.event });
    } catch (e) {
      // A queued publish lands via the retry worker; treating it as a failure
      // invites a retry that re-rolls the random `d` suffix, creating two themes.
      if (!isPublishQueuedError(e)) throw e;
      event = e.event;
      queued = true;
    }

    const addr = addrOf(event);
    patchDiscoverThemes(
      queryClient,
      (events, firstPage) => {
        const rest = events.filter((e) => e.id !== event.id && addrOf(e) !== addr);
        return firstPage && !editing ? [event, ...rest] : events.map((e) => (addrOf(e) === addr ? event : e));
      },
      !editing,
    );
    if (user) upsertUserTheme(queryClient, user.pubkey, event);
    else void queryClient.invalidateQueries({ queryKey: ["user-themes"], refetchType: "none" });

    return { event, queued };
  }, [publishEvent, queryClient, user]);

  /** NIP-09 delete of one of the user's themes; removed from every cached list at once. */
  const deleteTheme = useCallback(async (theme: UserTheme) => {
    if (!user) throw new Error("Not signed in");
    try {
      await publishEvent(buildThemeDeletionEvent(user.pubkey, theme.identifier, theme.event.id));
    } catch (e) {
      if (!isPublishQueuedError(e)) throw e;
    }

    const addr = addrOf(theme.event);
    queryClient.setQueryData<UserTheme[]>(
      ["user-themes", user.pubkey],
      (prev) => prev?.filter((t) => t.identifier !== theme.identifier),
    );
    patchDiscoverThemes(queryClient, (events) => events.filter((e) => addrOf(e) !== addr), false);
  }, [user, publishEvent, queryClient]);

  return { publishTheme, deleteTheme, isPending };
}

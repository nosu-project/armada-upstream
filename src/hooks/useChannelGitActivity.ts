import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import {
  EVENT_DELETION_KIND,
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  GIT_REPOSITORY_ANNOUNCEMENT_KIND,
  GIT_STATUS_KINDS,
  NIP22_COMMENT_KIND,
  buildGitTimelineActivities,
  parseGitComment,
  parseGitRepositoryAnnouncement,
  parseGitStatusEvent,
  matchGitTicketRepository,
  parseGitTicket,
  type GitRepositoryAttachment,
  type GitTicket,
  type GitTimelineActivity,
} from "@/lib/gitActivity";
import { CI_EVENT_KINDS } from "@/lib/ci";
import { useWireScopes } from "@/wire/useWireScopes";

/**
 * One shared empty result, so a channel with no Git activity — every channel,
 * most of the time — hands back the SAME array on every render. A fresh `[]`
 * here changes `mergeChannelTimeline`'s input identity on each pass, which
 * re-sorts the whole conversation and hands every row new props to diff.
 */
const NO_ACTIVITY: GitTimelineActivity[] = [];

/**
 * Store-first Git activity for a channel. All roots and children are read in
 * repository batches, so activity rows never open their own profile/repository,
 * ticket, or relay query.
 */
export function useChannelGitActivity(
  channelId: string | undefined,
  attachments: readonly GitRepositoryAttachment[],
): { activities: GitTimelineActivity[]; isLoading: boolean; isLoadingOlder: boolean; hasMore: boolean; loadOlder: () => Promise<number>; refreshTicket: (ticket: GitTicket) => Promise<number> } {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const normalized = useMemo(() => [...attachments].sort((a, b) => a.address.coordinate.localeCompare(b.address.coordinate) || a.attachedAt - b.attachedAt), [attachments]);
  const addresses = useMemo(() => [...new Set(normalized.map((attachment) => attachment.address.coordinate))], [normalized]);
  const queryKey = useMemo(
    () => ["git", "channel-activity", channelId, normalized.map((a) => `${a.address.coordinate}:${a.attachedAt}:${a.detachedAt ?? ""}`).join("|")] as const,
    [channelId, normalized],
  );
  const query = useQuery({
    queryKey,
    enabled: Boolean(channelId && addresses.length),
    queryFn: async (): Promise<GitTimelineActivity[]> => {
      const store = await eventStore;
      const roots = await store.query([{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": addresses, limit: 2_000 }]);
      // CI runs address the repository directly, so they read alongside roots
      // rather than hanging off a discovered ticket.
      const ci = await store.query([{ kinds: [...CI_EVENT_KINDS], "#a": addresses, limit: 4_000 }]);
      const addressSet = new Set(addresses);
      const validRoots = roots.filter((event) => {
        const ticket = parseGitTicket(event);
        return Boolean(ticket && matchGitTicketRepository(ticket, addressSet));
      });
      const rootIds = [...new Set(validRoots.map((root) => root.id))].sort();
      const children = rootIds.length === 0 ? [] : await store.query([
        { kinds: [NIP22_COMMENT_KIND], "#E": rootIds, limit: 4_000 },
        { kinds: [...GIT_STATUS_KINDS], "#e": rootIds, limit: 4_000 },
      ]);
      // Author-published NIP-09 retractions of those children (comment edits/deletes).
      const childIds = [...new Set(children.map((child) => child.id))].sort();
      const deletions = childIds.length === 0 ? [] : await store.query([{ kinds: [EVENT_DELETION_KIND], "#e": childIds, limit: 4_000 }]);
      const announcements = await store.query(normalized.map((attachment) => ({
        kinds: [GIT_REPOSITORY_ANNOUNCEMENT_KIND], authors: [attachment.address.owner], "#d": [attachment.address.identifier], limit: 1,
      })));
      return buildGitTimelineActivities([...validRoots, ...children, ...deletions, ...ci], normalized, announcements.map(parseGitRepositoryAnnouncement).filter((repository): repository is NonNullable<typeof repository> => Boolean(repository)));
    },
  });
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // The wire keeps repository activity live. Older pages are a store-first
  // cursor scan: if another Git consumer already hydrated roots, scrolling the
  // mixed timeline can still expose them without making a duplicate UI query.
  const loadOlder = useCallback(async () => {
    if (!addresses.length) return 0;
    const current = queryClient.getQueryData<GitTimelineActivity[]>(queryKey) ?? [];
    const oldest = current.reduce((value, activity) => Math.min(value, activity.createdAt), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(oldest) || isLoadingOlder || !hasMore) return 0;
    setIsLoadingOlder(true);
    try {
      const store = await eventStore;
      const roots = await store.query([{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": addresses, until: oldest - 1, limit: 2_000 }]);
      if (roots.length === 0) {
        setHasMore(false);
        return 0;
      }
      await queryClient.invalidateQueries({ queryKey });
      // `queryFn` rebuilds and dedupes the activity list; count roots rather
      // than raw children so callers have a truthful non-zero prepend signal.
      setHasMore(roots.length === 2_000);
      return roots.length;
    } finally {
      setIsLoadingOlder(false);
    }
  }, [addresses, eventStore, hasMore, isLoadingOlder, queryClient, queryKey]);
  const refreshTicket = useCallback(async (ticket: GitTicket): Promise<number> => {
    // Any repository the ticket tags that we actually hold — not just its first.
    const ticketCoordinates = new Set(ticket.repositoryAddresses.map((address) => address.coordinate));
    const relays = [...new Set(normalized
      .filter((attachment) => ticketCoordinates.has(attachment.address.coordinate))
      .flatMap((attachment) => attachment.relayHints))];
    if (!relays.length) return 0;
    const store = await eventStore;
    let received = 0;
    await Promise.all(relays.map(async (relay) => {
      try {
        const events = await nostr.relay(relay).query(
          [
            { kinds: [NIP22_COMMENT_KIND], "#E": [ticket.id], limit: 4_000 },
            { kinds: [...GIT_STATUS_KINDS], "#e": [ticket.id], limit: 4_000 },
          ],
          { signal: AbortSignal.timeout(8_000) },
        );
        for (const event of events) {
          const comment = parseGitComment(event);
          const status = parseGitStatusEvent(event);
          if ((!comment || comment.ticketId !== ticket.id) && (!status || status.ticketId !== ticket.id)) continue;
          await store.event(event).catch(() => undefined);
          received++;
        }
      } catch {
        // The thread remains readable from the shared store if a relay is unavailable.
      }
    }));
    // Retractions for the ticket's stored comments (NIP-09 deletes/edits).
    const stored = await store.query([{ kinds: [NIP22_COMMENT_KIND], "#E": [ticket.id], limit: 4_000 }]);
    const commentIds = new Set(stored.map((event) => event.id));
    if (commentIds.size > 0) {
      const ids = [...commentIds].sort();
      await Promise.all(relays.map(async (relay) => {
        try {
          const retractions = await nostr.relay(relay).query(
            [{ kinds: [EVENT_DELETION_KIND], "#e": ids, limit: 4_000 }],
            { signal: AbortSignal.timeout(8_000) },
          );
          for (const event of retractions) {
            if (!event.tags.some(([name, value]) => name === "e" && value && commentIds.has(value))) continue;
            await store.event(event).catch(() => undefined);
            received++;
          }
        } catch {
          // Best effort; local retractions still apply.
        }
      }));
    }
    if (received) await queryClient.invalidateQueries({ queryKey });
    return received;
  }, [eventStore, normalized, nostr, queryClient, queryKey]);
  useWireScopes((scopes) => {
    if (addresses.some((address) => scopes.has(`git:${address}`))) void queryClient.invalidateQueries({ queryKey });
  });
  return { activities: query.data ?? NO_ACTIVITY, isLoading: query.isLoading, isLoadingOlder, hasMore: hasMore && addresses.length > 0, loadOlder, refreshTicket };
}

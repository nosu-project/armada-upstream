import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import type { ProjectRepo, ProjectWorkItem } from "@/components/projects/projectData";
import { useEventStore } from "@/hooks/useEventStore";
import {
  EVENT_DELETION_KIND,
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  GIT_REPOSITORY_ANNOUNCEMENT_KIND,
  GIT_STATUS_KINDS,
  NIP22_COMMENT_KIND,
  buildGitTimelineActivities,
  collectGitDeletions,
  isGitEventDeleted,
  gitStatusFromKind,
  matchGitTicketRepository,
  parseGitComment,
  parseGitRepositoryAnnouncement,
  parseGitStatusEvent,
  parseGitTicket,
  resolveGitTicketStatus,
  type GitRepositoryAddress,
  type GitRepositoryAttachment,
  type GitTicket,
  type GitTimelineActivity,
} from "@/lib/gitActivity";
import { emitWireScopes } from "@/wire/bus";
import { useWireScopes } from "@/wire/useWireScopes";

const PAGE_SIZE = 100;
const MAX_ROOT_PAGES = 5;
const PULL_TIMEOUT_MS = 8_000;

/** One repository the Projects view covers, folded across every channel that attached it. */
export interface GitProjectSource {
  address: GitRepositoryAddress;
  relayHints: string[];
  /** Names of the channels holding an active attachment, for the repo subtitle. */
  channels: string[];
  /** Earliest active attach time; a display fallback when no announcement is known. */
  attachedAt: number;
}

/**
 * Fold the community's per-channel attachments into one source per repository.
 * Only active attachments count: the Projects view browses what the community
 * is currently connected to, full history included.
 */
export function gitProjectSources(
  attachmentsByChannel: ReadonlyMap<string, readonly GitRepositoryAttachment[]>,
  channelNameById: ReadonlyMap<string, string>,
): GitProjectSource[] {
  const byCoordinate = new Map<string, GitProjectSource>();
  for (const [channelId, attachments] of attachmentsByChannel) {
    const channelName = channelNameById.get(channelId);
    for (const attachment of attachments) {
      if (attachment.detachedAt !== undefined) continue;
      const existing = byCoordinate.get(attachment.address.coordinate);
      if (existing) {
        existing.relayHints = [...new Set([...existing.relayHints, ...attachment.relayHints])];
        if (channelName && !existing.channels.includes(channelName)) existing.channels.push(channelName);
        existing.attachedAt = Math.min(existing.attachedAt, attachment.attachedAt);
      } else {
        byCoordinate.set(attachment.address.coordinate, {
          address: attachment.address,
          relayHints: [...attachment.relayHints],
          channels: channelName ? [channelName] : [],
          attachedAt: attachment.attachedAt,
        });
      }
    }
  }
  return [...byCoordinate.values()].sort((a, b) => a.address.coordinate.localeCompare(b.address.coordinate));
}

export interface GitProjects {
  repos: ProjectRepo[];
  items: ProjectWorkItem[];
  /** Ungated activities (full history) for the ticket conversation panel. */
  activities: GitTimelineActivity[];
  ticketsById: Map<string, GitTicket>;
}

/**
 * Assemble the Projects data from raw store events. Unlike the channel
 * timeline this is deliberately NOT gated on attachment intervals — the
 * Projects view is where a repository's complete history lives. `activities`
 * are built by the shared timeline builder, so author-published NIP-09
 * retractions in `events` remove their comments here too.
 */
export function assembleGitProjects(sources: readonly GitProjectSource[], events: readonly NostrEvent[]): GitProjects {
  const coordinates = new Set(sources.map((source) => source.address.coordinate));

  const announcements = new Map<string, ReturnType<typeof parseGitRepositoryAnnouncement>>();
  for (const event of events) {
    const announcement = parseGitRepositoryAnnouncement(event);
    if (!announcement || !coordinates.has(announcement.address.coordinate)) continue;
    const previous = announcements.get(announcement.address.coordinate);
    if (!previous || announcement.createdAt > previous.createdAt) {
      announcements.set(announcement.address.coordinate, announcement);
    }
  }

  const deletions = collectGitDeletions(events);
  const tickets = new Map<string, GitTicket>();
  const ticketRepository = new Map<string, GitRepositoryAddress>();
  for (const event of events) {
    const ticket = parseGitTicket(event);
    if (!ticket) continue;
    if (isGitEventDeleted(deletions, ticket.id, ticket.author)) continue;
    const repository = matchGitTicketRepository(ticket, coordinates);
    if (!repository) continue;
    tickets.set(ticket.id, ticket);
    ticketRepository.set(ticket.id, repository);
  }

  const statusesByTicket = new Map<string, NostrEvent[]>();
  for (const event of events) {
    const status = parseGitStatusEvent(event);
    if (!status || !tickets.has(status.ticketId)) continue;
    if (isGitEventDeleted(deletions, status.event.id, status.author)) continue;
    const list = statusesByTicket.get(status.ticketId);
    if (list) list.push(event);
    else statusesByTicket.set(status.ticketId, [event]);
  }

  const repos: ProjectRepo[] = sources.map((source) => {
    const announcement = announcements.get(source.address.coordinate);
    const subtitle = source.channels.map((name) => `#${name}`).join(" · ") || undefined;
    return {
      coord: source.address.coordinate,
      owner: source.address.owner,
      id: source.address.identifier,
      name: announcement?.name ?? source.address.identifier,
      description: announcement?.description,
      cloneUrls: announcement?.cloneUrls ?? [],
      webUrl: announcement?.webUrls[0],
      contributors: announcement?.maintainers ?? [],
      createdAt: announcement?.createdAt ?? source.attachedAt,
      event: announcement?.event,
      subtitle,
    };
  });

  // All-time pseudo-attachments turn the timeline builder's interval gate into
  // a no-op while keeping its trust rules for status changes.
  const allTime = sources.map((source) => ({ address: source.address, relayHints: [], attachedAt: 0 }));
  const activities = buildGitTimelineActivities(
    events,
    allTime,
    [...announcements.values()].filter((a): a is NonNullable<typeof a> => Boolean(a)),
  );

  // Discussion sizes from the built activities, so retracted comments don't count.
  const commentCounts = new Map<string, number>();
  for (const activity of activities) {
    if (activity.type !== "comment") continue;
    commentCounts.set(activity.ticket.id, (commentCounts.get(activity.ticket.id) ?? 0) + 1);
  }

  const items: ProjectWorkItem[] = [...tickets.values()]
    .map((ticket) => {
      const repository = ticketRepository.get(ticket.id)!;
      const announcement = announcements.get(repository.coordinate);
      const status = resolveGitTicketStatus(
        ticket,
        { owner: announcement?.owner ?? repository.owner, maintainers: announcement?.maintainers ?? [] },
        statusesByTicket.get(ticket.id) ?? [],
      );
      return {
        id: ticket.id,
        kind: ticket.type === "issue" ? "issue" as const : "pr" as const,
        title: ticket.subject,
        content: ticket.content,
        author: ticket.author,
        createdAt: ticket.createdAt,
        repoCoord: repository.coordinate,
        status: gitStatusFromKind(status?.kind, ticket.kind),
        event: ticket.event,
        labels: ticket.labels,
        commentCount: commentCounts.get(ticket.id) ?? 0,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));

  return { repos, items, activities, ticketsById: tickets };
}

function sourceRelays(source: GitProjectSource): string[] {
  return source.relayHints.filter((relay) => !relay.includes("index.ngit.dev"));
}

/**
 * Deep-sync attempts per coordinate this app session (module scope survives
 * view unmounts). A repository is done once a relay actually answered; total
 * failures retry up to the cap so an offline first open isn't final, without
 * looping while offline. Manual refresh clears the slate.
 */
const deepSyncAttempts = new Map<string, number>();
const MAX_SYNC_ATTEMPTS = 2;
/** Fan-out bounds: repos and relay hints are admin-controlled data. */
const SYNC_SOURCES_PER_RUN = 4;
const MAX_SYNC_RELAYS = 8;
/** Relays cap REQ/filter sizes; id lists are chunked to stay under them. */
const RELAY_ID_CHUNK = 200;

function chunked<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * Store-first Projects data for a community's attached repositories, with a
 * one-time deep history sync per repository from its activity relays. The wire
 * keeps activity live from its cursors forward; this hook backfills everything
 * older, so browsing does not depend on when the repository was attached.
 */
export function useGitProjects(
  attachmentsByChannel: ReadonlyMap<string, readonly GitRepositoryAttachment[]>,
  channelNameById: ReadonlyMap<string, string>,
  enabled: boolean,
): GitProjects & {
  isLoading: boolean;
  isSyncing: boolean;
  refresh: () => void;
  refreshTicket: (ticket: GitTicket) => Promise<number>;
  relaysForCoordinates: (coordinates: readonly string[]) => string[];
} {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const sources = useMemo(
    () => gitProjectSources(attachmentsByChannel, channelNameById),
    [attachmentsByChannel, channelNameById],
  );
  const signature = useMemo(
    () => sources.map((source) => `${source.address.coordinate}:${source.channels.join("+")}`).join("|"),
    [sources],
  );
  const queryKey = useMemo(() => ["git", "projects", signature] as const, [signature]);

  const query = useQuery({
    queryKey,
    enabled: enabled && sources.length > 0,
    queryFn: async (): Promise<GitProjects> => {
      const store = await eventStore;
      const addresses = sources.map((source) => source.address.coordinate);
      const announcements = await store.query(sources.map((source) => ({
        kinds: [GIT_REPOSITORY_ANNOUNCEMENT_KIND], authors: [source.address.owner], "#d": [source.address.identifier], limit: 1,
      })));
      const roots = await store.query([{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": addresses, limit: 5_000 }]);
      const rootIds = [...new Set(roots.map((root) => root.id))].sort();
      const children = rootIds.length === 0 ? [] : await store.query([
        { kinds: [NIP22_COMMENT_KIND], "#E": rootIds, limit: 8_000 },
        { kinds: [...GIT_STATUS_KINDS], "#e": rootIds, limit: 8_000 },
      ]);
      const childIds = [...new Set(children.map((child) => child.id))].sort();
      const deletions = childIds.length === 0 ? [] : await store.query([{ kinds: [EVENT_DELETION_KIND], "#e": childIds, limit: 8_000 }]);
      return assembleGitProjects(sources, [...announcements, ...roots, ...children, ...deletions]);
    },
  });

  // One-time deep history sync per repository. Roots are paged oldest-ward
  // with `until` cursors; children are then fetched for every known root so
  // pre-attachment discussion threads become readable too.
  const syncing = useRef(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncNonce, setSyncNonce] = useState(0);
  useEffect(() => {
    void syncNonce;
    if (!enabled || syncing.current) return;
    // A bounded batch per run; the finally-nonce re-fires the effect until no
    // source is pending (sources attached mid-sync included).
    const pending = sources
      .filter((source) => (deepSyncAttempts.get(source.address.coordinate) ?? 0) < MAX_SYNC_ATTEMPTS && sourceRelays(source).length > 0)
      .slice(0, SYNC_SOURCES_PER_RUN);
    if (pending.length === 0) return;
    syncing.current = true;
    setIsSyncing(true);
    void (async () => {
      const touched = new Set<string>();
      try {
        const store = await eventStore;
        await Promise.all(pending.map(async (source) => {
          const relays = sourceRelays(source).slice(0, MAX_SYNC_RELAYS);
          const coordinate = source.address.coordinate;
          // "Done" requires a relay to have actually answered — a fully
          // offline run must stay retryable, not read as an empty repo.
          let answered = false;
          const query = async (relay: string, filter: NostrFilter): Promise<NostrEvent[]> => {
            try {
              const events = await nostr.relay(relay).query([filter], { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) });
              answered = true;
              return events;
            } catch {
              return [];
            }
          };

          // Freshest announcement (name/description/maintainers may have moved).
          const announced = (await Promise.all(relays.map((relay) => query(relay, {
            kinds: [GIT_REPOSITORY_ANNOUNCEMENT_KIND], authors: [source.address.owner], "#d": [source.address.identifier], limit: 1,
          })))).flat();
          for (const event of announced) {
            if (parseGitRepositoryAnnouncement(event)?.address.coordinate === coordinate) {
              await store.event(event).catch(() => undefined);
            }
          }

          // Full root history, paged oldest-ward. The cursor steps TO the
          // oldest seen second (`seen` dedupes the overlap) so a page cut
          // mid-second doesn't skip its remaining siblings; it only steps
          // past a second once a page yields nothing new.
          const seen = new Set<string>();
          let until: number | undefined;
          for (let page = 0; page < MAX_ROOT_PAGES; page++) {
            const filter = {
              kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": [coordinate],
              ...(until === undefined ? {} : { until }), limit: PAGE_SIZE,
            };
            const pages = await Promise.all(relays.map((relay) => query(relay, filter)));
            const all = pages.flat();
            const fresh: NostrEvent[] = [];
            for (const event of all) {
              if (seen.has(event.id)) continue;
              const ticket = parseGitTicket(event);
              if (!ticket || matchGitTicketRepository(ticket, new Set([coordinate])) === undefined) continue;
              seen.add(event.id);
              fresh.push(event);
            }
            for (const event of fresh) await store.event(event).catch(() => undefined);
            const mayHaveOlder = pages.some((list) => list.length >= PAGE_SIZE);
            if (!mayHaveOlder || all.length === 0) break;
            const oldest = Math.min(...all.map((event) => event.created_at));
            until = fresh.length > 0 ? oldest : oldest - 1;
          }

          // Children for every root now known for this repository, in
          // relay-safe id chunks.
          const roots = await store.query([{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": [coordinate], limit: 5_000 }]);
          const rootIds = [...new Set(roots.map((root) => root.id))].sort();
          const rootIdSet = new Set(rootIds);
          const childIds = new Set<string>();
          for (const ids of chunked(rootIds, RELAY_ID_CHUNK)) {
            const children = (await Promise.all(relays.flatMap((relay) => [
              query(relay, { kinds: [NIP22_COMMENT_KIND], "#E": ids, limit: 4_000 }),
              query(relay, { kinds: [...GIT_STATUS_KINDS], "#e": ids, limit: 4_000 }),
            ]))).flat();
            for (const event of children) {
              const comment = parseGitComment(event);
              const status = parseGitStatusEvent(event);
              if ((!comment || !rootIdSet.has(comment.ticketId)) && (!status || !rootIdSet.has(status.ticketId))) continue;
              childIds.add(event.id);
              await store.event(event).catch(() => undefined);
            }
          }
          // Author-published retractions of those children (NIP-09 deletes/edits).
          for (const ids of chunked([...childIds].sort(), RELAY_ID_CHUNK)) {
            const retractions = (await Promise.all(relays.map((relay) =>
              query(relay, { kinds: [EVENT_DELETION_KIND], "#e": ids, limit: 4_000 })))).flat();
            for (const event of retractions) {
              if (!event.tags.some(([name, value]) => name === "e" && value && childIds.has(value))) continue;
              await store.event(event).catch(() => undefined);
            }
          }

          if (answered) {
            deepSyncAttempts.set(coordinate, MAX_SYNC_ATTEMPTS);
            touched.add(`git:${coordinate}`);
          } else {
            deepSyncAttempts.set(coordinate, (deepSyncAttempts.get(coordinate) ?? 0) + 1);
          }
        }));
      } finally {
        syncing.current = false;
        setIsSyncing(false);
        if (touched.size > 0) emitWireScopes(touched);
        void queryClient.invalidateQueries({ queryKey });
        // Continue with whatever is still pending (or no-op when done).
        setSyncNonce((nonce) => nonce + 1);
      }
    })();
  }, [enabled, sources, eventStore, nostr, queryClient, queryKey, syncNonce]);

  // Forget this session's sync marks so the next effect run re-pulls everything.
  const refresh = useCallback(() => {
    for (const source of sources) deepSyncAttempts.delete(source.address.coordinate);
    setSyncNonce((nonce) => nonce + 1);
  }, [sources]);

  // Pull one ticket's full thread from the repository relays on demand.
  const refreshTicket = useCallback(async (ticket: GitTicket): Promise<number> => {
    const ticketCoordinates = new Set(ticket.repositoryAddresses.map((address) => address.coordinate));
    const relays = [...new Set(sources
      .filter((source) => ticketCoordinates.has(source.address.coordinate))
      .flatMap(sourceRelays))];
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
          { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) },
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
    // Retractions for every comment the store now holds for this ticket, so a
    // comment deleted or edited from another device disappears here too.
    const stored = await store.query([{ kinds: [NIP22_COMMENT_KIND], "#E": [ticket.id], limit: 4_000 }]);
    const commentIds = new Set(stored.map((event) => event.id));
    if (commentIds.size > 0) {
      const ids = [...commentIds].sort();
      await Promise.all(relays.map(async (relay) => {
        try {
          const retractions = await nostr.relay(relay).query(
            [{ kinds: [EVENT_DELETION_KIND], "#e": ids, limit: 4_000 }],
            { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) },
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
  }, [eventStore, nostr, queryClient, queryKey, sources]);

  useWireScopes((scopes) => {
    if (sources.some((source) => scopes.has(`git:${source.address.coordinate}`))) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

  // Activity relays for a set of repository coordinates (write targets).
  const relaysForCoordinates = useCallback((coordinates: readonly string[]): string[] => {
    const wanted = new Set(coordinates);
    return [...new Set(sources.filter((source) => wanted.has(source.address.coordinate)).flatMap(sourceRelays))];
  }, [sources]);

  const data = query.data;
  return useMemo(() => ({
    repos: data?.repos ?? [],
    items: data?.items ?? [],
    activities: data?.activities ?? [],
    ticketsById: data?.ticketsById ?? new Map(),
    isLoading: query.isLoading,
    isSyncing,
    refresh,
    refreshTicket,
    relaysForCoordinates,
  }), [data, query.isLoading, isSyncing, refresh, refreshTicket, relaysForCoordinates]);
}

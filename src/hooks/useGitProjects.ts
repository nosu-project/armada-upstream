import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import type { ProjectRepo, ProjectWorkItem } from "@/components/projects/projectData";
import { useEventStore } from "@/hooks/useEventStore";
import {
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  GIT_REPOSITORY_ANNOUNCEMENT_KIND,
  GIT_STATUS_KINDS,
  NIP22_COMMENT_KIND,
  buildGitTimelineActivities,
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
 * Projects view is where a repository's complete history lives.
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

  const tickets = new Map<string, GitTicket>();
  const ticketRepository = new Map<string, GitRepositoryAddress>();
  for (const event of events) {
    const ticket = parseGitTicket(event);
    if (!ticket) continue;
    const repository = matchGitTicketRepository(ticket, coordinates);
    if (!repository) continue;
    tickets.set(ticket.id, ticket);
    ticketRepository.set(ticket.id, repository);
  }

  const statusesByTicket = new Map<string, NostrEvent[]>();
  for (const event of events) {
    const status = parseGitStatusEvent(event);
    if (!status || !tickets.has(status.ticketId)) continue;
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
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));

  // All-time pseudo-attachments turn the timeline builder's interval gate into
  // a no-op while keeping its trust rules for status changes.
  const allTime = sources.map((source) => ({ address: source.address, relayHints: [], attachedAt: 0 }));
  const activities = buildGitTimelineActivities(
    events,
    allTime,
    [...announcements.values()].filter((a): a is NonNullable<typeof a> => Boolean(a)),
  );

  return { repos, items, activities, ticketsById: tickets };
}

function sourceRelays(source: GitProjectSource): string[] {
  return source.relayHints.filter((relay) => !relay.includes("index.ngit.dev"));
}

/** Coordinates already deep-synced this app session (module scope survives view unmounts). */
const deepSynced = new Set<string>();

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
      return assembleGitProjects(sources, [...announcements, ...roots, ...children]);
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
    const pending = sources.filter((source) => !deepSynced.has(source.address.coordinate) && sourceRelays(source).length > 0);
    if (pending.length === 0) return;
    syncing.current = true;
    setIsSyncing(true);
    void (async () => {
      const touched = new Set<string>();
      try {
        const store = await eventStore;
        await Promise.all(pending.map(async (source) => {
          const relays = sourceRelays(source);
          const coordinate = source.address.coordinate;
          const query = async (relay: string, filter: NostrFilter): Promise<NostrEvent[]> => {
            try {
              return await nostr.relay(relay).query([filter], { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) });
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

          // Full root history, paged oldest-ward.
          const seen = new Set<string>();
          let until: number | undefined;
          for (let page = 0; page < MAX_ROOT_PAGES; page++) {
            const filter = {
              kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": [coordinate],
              ...(until === undefined ? {} : { until }), limit: PAGE_SIZE,
            };
            const pages = await Promise.all(relays.map((relay) => query(relay, filter)));
            const fresh: NostrEvent[] = [];
            for (const event of pages.flat()) {
              if (seen.has(event.id)) continue;
              const ticket = parseGitTicket(event);
              if (!ticket || matchGitTicketRepository(ticket, new Set([coordinate])) === undefined) continue;
              seen.add(event.id);
              fresh.push(event);
            }
            for (const event of fresh) await store.event(event).catch(() => undefined);
            const mayHaveOlder = pages.some((list) => list.length >= PAGE_SIZE);
            if (fresh.length === 0 || !mayHaveOlder) break;
            until = Math.min(...fresh.map((event) => event.created_at)) - 1;
          }

          // Children for every root now known for this repository.
          const roots = await store.query([{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": [coordinate], limit: 5_000 }]);
          const rootIds = [...new Set(roots.map((root) => root.id))].sort();
          if (rootIds.length > 0) {
            const children = (await Promise.all(relays.flatMap((relay) => [
              query(relay, { kinds: [NIP22_COMMENT_KIND], "#E": rootIds, limit: 4_000 }),
              query(relay, { kinds: [...GIT_STATUS_KINDS], "#e": rootIds, limit: 4_000 }),
            ]))).flat();
            const rootIdSet = new Set(rootIds);
            for (const event of children) {
              const comment = parseGitComment(event);
              const status = parseGitStatusEvent(event);
              if ((!comment || !rootIdSet.has(comment.ticketId)) && (!status || !rootIdSet.has(status.ticketId))) continue;
              await store.event(event).catch(() => undefined);
            }
          }

          deepSynced.add(coordinate);
          touched.add(`git:${coordinate}`);
        }));
      } finally {
        syncing.current = false;
        setIsSyncing(false);
        if (touched.size > 0) emitWireScopes(touched);
        void queryClient.invalidateQueries({ queryKey });
      }
    })();
  }, [enabled, sources, eventStore, nostr, queryClient, queryKey, syncNonce]);

  // Forget this session's sync marks so the next effect run re-pulls everything.
  const refresh = useCallback(() => {
    for (const source of sources) deepSynced.delete(source.address.coordinate);
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

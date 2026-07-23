import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import {
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  GIT_STATUS_KINDS,
  NIP22_COMMENT_KIND,
  parseGitComment,
  parseGitStatusEvent,
  matchGitTicketRepository,
  parseGitTicket,
} from "@/lib/gitActivity";
import { useWireScopes } from "@/wire/useWireScopes";

import type { GitRepositoryWireInput } from "@/wire/spec";
import type { NostrEvent } from "@nostrify/nostrify";

/** A bounded bootstrap is enough to construct dynamic comment/status filters. */
const ROOT_DISCOVERY_LIMIT = 500;
const ROOT_DISCOVERY_TIMEOUT_MS = 8_000;
/** Keep direct child backfill requests at the same conservative size as wire REQs. */
const ROOT_FILTER_CHUNK_SIZE = 100;

/**
 * Cache-first root discovery for every actively attached repository.
 *
 * Roots deliberately ignore attachment intervals: an issue opened before an
 * attachment is not channel activity, but its id is still needed to subscribe
 * to comments and statuses posted while the repository is attached.
 */
export function useWireGitTicketRoots(repositories: readonly GitRepositoryWireInput[]): NostrEvent[] {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const active = useMemo(() => repositories
    .filter((repository) => repository.attachments.some(({ attachment }) => attachment.detachedAt === undefined))
    .map((repository) => ({
      address: repository.address,
      relays: [...new Set(repository.relays)].filter((relay) => !relay.includes("index.ngit.dev")).sort(),
    }))
    .sort((a, b) => a.address.localeCompare(b.address)), [repositories]);
  const signature = active.map((repository) => `${repository.address}:${repository.relays.join(",")}`).join("|");
  const queryKey = ["wire", "git-ticket-roots", signature] as const;

  const query = useQuery<NostrEvent[]>({
    queryKey,
    enabled: active.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const store = await eventStore;
      const addresses = active.map((repository) => repository.address);
      const received = await store.query([{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": addresses, limit: ROOT_DISCOVERY_LIMIT }]);
      const addressesByRelay = new Map<string, Set<string>>();
      for (const repository of active) {
        for (const relay of repository.relays) {
          let atRelay = addressesByRelay.get(relay);
          if (!atRelay) addressesByRelay.set(relay, (atRelay = new Set()));
          atRelay.add(repository.address);
        }
      }
      await Promise.all([...addressesByRelay].map(async ([relay, atRelay]) => {
          try {
            const events = await nostr.relay(relay).query(
              [{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": [...atRelay].sort(), limit: ROOT_DISCOVERY_LIMIT }],
              { signal: AbortSignal.timeout(ROOT_DISCOVERY_TIMEOUT_MS) },
            );
            for (const event of events) {
              const ticket = parseGitTicket(event);
              if (!ticket || !matchGitTicketRepository(ticket, atRelay)) continue;
              await store.event(event).catch(() => undefined);
              received.push(event);
            }
          } catch {
            // Cache data and other activity relays remain useful.
          }
      }));
      const roots = new Map<string, NostrEvent>();
      const activeAddresses = new Set(active.map((repository) => repository.address));
      for (const event of received) {
        const ticket = parseGitTicket(event);
        if (ticket && matchGitTicketRepository(ticket, activeAddresses)) roots.set(event.id, event);
      }

      // The standing child filters are installed only after this root discovery
      // query completes. Their cursor-based replay cannot recover comments that
      // predate the relay cursor, so backfill children for every discovered root
      // directly before returning it to the wire spec.
      await Promise.all([...addressesByRelay].map(async ([relay, atRelay]) => {
        const rootIds = [...roots.values()]
          .filter((root) => {
            const ticket = parseGitTicket(root);
            return Boolean(ticket && matchGitTicketRepository(ticket, atRelay));
          })
          .map((root) => root.id)
          .sort();
        for (let offset = 0; offset < rootIds.length; offset += ROOT_FILTER_CHUNK_SIZE) {
          const ids = rootIds.slice(offset, offset + ROOT_FILTER_CHUNK_SIZE);
          try {
            const children = await nostr.relay(relay).query(
              [
                { kinds: [NIP22_COMMENT_KIND], "#E": ids, limit: ROOT_DISCOVERY_LIMIT },
                { kinds: [...GIT_STATUS_KINDS], "#e": ids, limit: ROOT_DISCOVERY_LIMIT },
              ],
              { signal: AbortSignal.timeout(ROOT_DISCOVERY_TIMEOUT_MS) },
            );
            for (const child of children) {
              const comment = parseGitComment(child);
              const status = parseGitStatusEvent(child);
              if ((!comment || !roots.has(comment.ticketId)) && (!status || !roots.has(status.ticketId))) continue;
              await store.event(child).catch(() => undefined);
            }
          } catch {
            // The standing child subscription and other activity relays remain useful.
          }
        }
      }));
      // The direct backfill bypasses wire ingestion, so explicitly refresh
      // channel activity queries after it has populated the shared event store.
      await queryClient.invalidateQueries({ queryKey: ["git", "channel-activity"] });
      return [...roots.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
  });

  useWireScopes((scopes) => {
    if (active.some((repository) => scopes.has(`git:${repository.address}`))) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

  return query.data ?? [];
}

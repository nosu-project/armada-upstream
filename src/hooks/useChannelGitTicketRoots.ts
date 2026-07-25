import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import {
  GIT_ISSUE_KIND,
  GIT_PULL_REQUEST_KIND,
  isGitRepositoryAttachedAt,
  parseGitTicket,
  type GitRepositoryAttachment,
} from "@/lib/gitActivity";
import { isGitAnnouncementDiscoveryRelay } from "@/lib/platform";
import { emitWireScopes } from "@/wire/bus";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrEvent } from "@nostrify/nostrify";

const PAGE_SIZE = 100;
const PULL_TIMEOUT_MS = 8_000;

export interface ChannelGitAttachment extends GitRepositoryAttachment {
  /** Announcement activity relays, not discovery relays. */
  activityRelays: string[];
}

export interface ChannelGitTicketRoots {
  roots: NostrEvent[];
  isLoading: boolean;
  isLoadingOlder: boolean;
  hasOlder: boolean;
  loadOlder: () => Promise<number>;
}

function key(channelId: string | undefined, attachments: readonly ChannelGitAttachment[]) {
  return ["git", "ticket-roots", channelId, attachments.map((a) => `${a.address.coordinate}:${a.attachedAt}:${a.detachedAt ?? ""}`).sort().join(",")] as const;
}

/** Deterministic store-side interval filtering for attached Git work-item roots. */
export function filterChannelGitTicketRoots(events: readonly NostrEvent[], attachments: readonly GitRepositoryAttachment[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const event of events) {
    const ticket = parseGitTicket(event);
    if (!ticket?.repositoryAddress) continue;
    if (!attachments.some((attachment) => attachment.address.coordinate === ticket.repositoryAddress!.coordinate && isGitRepositoryAttachedAt(attachment, event.created_at))) continue;
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

/** Safe exclusive cursor: do not request before the earliest relevant attachment. */
export function gitTicketOlderCursor(events: readonly NostrEvent[], attachments: readonly GitRepositoryAttachment[]): number | undefined {
  if (!events.length || !attachments.length) return undefined;
  const oldest = Math.min(...events.map((event) => event.created_at));
  const floor = Math.min(...attachments.map((attachment) => attachment.attachedAt));
  return oldest > floor ? oldest - 1 : undefined;
}

/**
 * Store-first NIP-34 issue/PR roots for one Concord V2 channel. The wire owns
 * live subscriptions; this hook only performs finite, interval-bounded pulls.
 */
export function useChannelGitTicketRoots(channelId: string | undefined, attachments: readonly ChannelGitAttachment[]): ChannelGitTicketRoots {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const normalized = useMemo(
    () => [...attachments].sort((a, b) => a.address.coordinate.localeCompare(b.address.coordinate) || a.attachedAt - b.attachedAt),
    [attachments],
  );
  const queryKey = useMemo(() => key(channelId, normalized), [channelId, normalized]);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const olderCursor = useRef<number | undefined>(undefined);
  const pulling = useRef(false);

  const query = useQuery<NostrEvent[]>({
    queryKey,
    enabled: Boolean(channelId && normalized.length),
    queryFn: async () => {
      const store = await eventStore;
      const cached = await Promise.all(normalized.map((attachment) => store.query([{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": [attachment.address.coordinate], limit: 500 }])));
      const roots = filterChannelGitTicketRoots(cached.flat(), normalized);
      olderCursor.current = gitTicketOlderCursor(roots, normalized);
      setHasOlder(olderCursor.current !== undefined);
      return roots;
    },
  });

  const pull = useCallback(async (until?: number): Promise<number> => {
    if (!channelId || !normalized.length) return 0;
    const store = await eventStore;
    const received: NostrEvent[] = [];
    await Promise.all(normalized.map(async (attachment) => {
      const upper = attachment.detachedAt === undefined ? until : Math.min(until ?? attachment.detachedAt - 1, attachment.detachedAt - 1);
      if (upper !== undefined && upper < attachment.attachedAt) return;
      const relays = [...new Set(attachment.activityRelays)].filter((relay) => !isGitAnnouncementDiscoveryRelay(relay));
      await Promise.all(relays.map(async (relay) => {
        try {
          const events = await nostr.relay(relay).query(
            [{ kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": [attachment.address.coordinate], since: attachment.attachedAt, ...(upper === undefined ? {} : { until: upper }), limit: PAGE_SIZE }],
            { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) },
          );
          for (const event of events) {
            const ticket = parseGitTicket(event);
            if (!ticket?.repositoryAddress || ticket.repositoryAddress.coordinate !== attachment.address.coordinate || !isGitRepositoryAttachedAt(attachment, event.created_at)) continue;
            await store.event(event).catch(() => undefined);
            received.push(event);
          }
        } catch { /* best effort; store data remains usable */ }
      }));
    }));
    if (received.length) emitWireScopes(new Set(received.map((event) => `git:${parseGitTicket(event)?.repositoryAddress?.coordinate}`)));
    return received.length;
  }, [channelId, eventStore, normalized, nostr]);

  // Recover complete active intervals even when the wire's relay cursor is newer
  // than the attachment time (for example, an offline metadata attach).
  useEffect(() => {
    if (!channelId || !normalized.length || pulling.current) return;
    pulling.current = true;
    void pull().finally(() => {
      pulling.current = false;
      void queryClient.invalidateQueries({ queryKey });
    });
  }, [channelId, normalized, pull, queryClient, queryKey]);

  useWireScopes((scopes) => {
    if (normalized.some((attachment) => scopes.has(`git:${attachment.address.coordinate}`))) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

  const loadOlder = useCallback(async () => {
    const until = olderCursor.current;
    if (pulling.current || until === undefined || !hasOlder) return 0;
    pulling.current = true;
    setIsLoadingOlder(true);
    try {
      const count = await pull(until);
      const current = queryClient.getQueryData<NostrEvent[]>(queryKey) ?? [];
      const next = filterChannelGitTicketRoots([...current], normalized);
      olderCursor.current = gitTicketOlderCursor(next, normalized);
      setHasOlder(count >= PAGE_SIZE && olderCursor.current !== undefined);
      await queryClient.invalidateQueries({ queryKey });
      return count;
    } finally {
      pulling.current = false;
      setIsLoadingOlder(false);
    }
  }, [hasOlder, normalized, pull, queryClient, queryKey]);

  return { roots: query.data ?? [], isLoading: query.isLoading, isLoadingOlder, hasOlder, loadOlder };
}

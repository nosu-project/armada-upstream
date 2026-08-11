import { useNostr } from "@nostrify/react";
import { useCallback, useMemo } from "react";

import type { NostrEvent } from "@nostrify/nostrify";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { toast } from "@/hooks/useToast";
import {
  buildGitCommentTemplate,
  buildGitDeletionTemplate,
  buildGitIssueTemplate,
  buildGitStatusTemplate,
  type GitComment,
  type GitEventTemplate,
  type GitRepositoryAddress,
  type GitStatusKind,
  type GitTicket,
} from "@/lib/gitActivity";
import { APP_NAME } from "@/lib/platform";
import { queueSignedEvent, removeQueuedPublish } from "@/lib/publishOutbox";
import { publishTimeoutMs } from "@/lib/publishTimeout";
import { emitWireScopes } from "@/wire/bus";

export interface GitWorkItemRepository {
  address: GitRepositoryAddress;
  maintainers: readonly string[];
}

/**
 * Signed NIP-34/NIP-22 writes against a repository's activity relays. Events
 * are stored locally before any network work (the shared store is what every
 * git surface renders from), queued for outbox retry, then published to each
 * activity relay; one acknowledgement counts as delivered.
 */
export function useGitWorkItemActions() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();

  const publish = useCallback(async (
    template: GitEventTemplate,
    relays: readonly string[],
    scopes: readonly string[],
    createdAt?: number,
  ): Promise<NostrEvent> => {
    if (!user) throw new Error("Sign in to participate in repository discussions.");
    if (!relays.length) throw new Error("This repository has no reachable activity relays.");

    // Same rule as useNostrPublish: this version is ours, not a carried-forward
    // `client` from a prior event's tags.
    const tags = [
      ...template.tags.filter(([name]) => name !== "client"),
      ["client", APP_NAME],
    ];
    const event = await user.signer.signEvent({
      kind: template.kind,
      content: template.content,
      tags,
      created_at: createdAt ?? Math.floor(Date.now() / 1000),
    });
    if (event.pubkey !== user.pubkey) {
      throw new Error("Signed event pubkey does not match the currently selected account.");
    }

    const store = await eventStore;
    await store.event(event).catch(() => undefined);
    await queueSignedEvent(event, relays[0]);
    emitWireScopes(new Set(scopes));

    const timeout = publishTimeoutMs(user.method);
    const results = await Promise.allSettled(
      relays.map((relay) => nostr.relay(relay).event(event, { signal: AbortSignal.timeout(timeout) })),
    );
    // The outbox entry targets relays[0]; only that relay's own ack clears
    // it, so a down primary keeps retrying even when a secondary delivered.
    if (results[0]?.status === "fulfilled") {
      await removeQueuedPublish(event.id).catch(() => undefined);
    }
    if (!results.some((result) => result.status === "fulfilled")) {
      toast({ title: "Delivery queued", description: "No repository relay answered. The post is saved and will retry." });
    }
    return event;
  }, [eventStore, nostr, user]);

  const commentOnTicket = useCallback(
    (ticket: GitTicket, content: string, relays: readonly string[], media: readonly string[][] = []) =>
      publish(
        buildGitCommentTemplate(ticket, content, relays[0] ?? "", media),
        relays,
        ticket.repositoryAddresses.map((address) => `git:${address.coordinate}`),
      ),
    [publish],
  );

  const openIssue = useCallback(
    (repository: GitWorkItemRepository, subject: string, body: string, relays: readonly string[], media: readonly string[][] = [], labels: readonly string[] = []) =>
      publish(
        buildGitIssueTemplate(repository, subject, body, relays[0] ?? "", media, labels),
        relays,
        [`git:${repository.address.coordinate}`],
      ),
    [publish],
  );

  const setTicketStatus = useCallback(
    (ticket: GitTicket, repository: GitWorkItemRepository, statusKind: GitStatusKind, relays: readonly string[]) =>
      publish(
        buildGitStatusTemplate(ticket, repository, statusKind, relays[0] ?? ""),
        relays,
        ticket.repositoryAddresses.map((address) => `git:${address.coordinate}`),
      ),
    [publish],
  );

  const deleteTicketComment = useCallback(
    (ticket: GitTicket, comment: GitComment, relays: readonly string[]) =>
      publish(
        buildGitDeletionTemplate(comment.event),
        relays,
        ticket.repositoryAddresses.map((address) => `git:${address.coordinate}`),
      ),
    [publish],
  );

  // Kind 1111 is not replaceable, so an edit is a NIP-09 retraction of the
  // old event plus a replacement comment at the ORIGINAL created_at (keeping
  // its thread position). Retraction goes FIRST so a retry after partial
  // failure is idempotent — re-retracting is harmless, and the worst
  // mid-failure state is a plain deletion, never a permanent duplicate.
  // The backdated replacement is invisible to since-cursor readers until
  // they re-fetch the thread (our panel refresh does on every open); a
  // fresh-dated replacement would instead reorder the thread everywhere.
  const editTicketComment = useCallback(
    async (ticket: GitTicket, comment: GitComment, content: string, relays: readonly string[]) => {
      const media = comment.event.tags
        .filter((tag) => tag[0] === "imeta" && tag.some((field) => {
          const url = field.startsWith("url ") ? field.slice(4) : undefined;
          return url !== undefined && content.includes(url);
        }));
      await publish(
        buildGitDeletionTemplate(comment.event),
        relays,
        ticket.repositoryAddresses.map((address) => `git:${address.coordinate}`),
      );
      return await publish(
        buildGitCommentTemplate(ticket, content, relays[0] ?? "", media),
        relays,
        ticket.repositoryAddresses.map((address) => `git:${address.coordinate}`),
        comment.createdAt,
      );
    },
    [publish],
  );

  return useMemo(
    () => ({ canWrite: Boolean(user), commentOnTicket, openIssue, setTicketStatus, deleteTicketComment, editTicketComment }),
    [user, commentOnTicket, openIssue, setTicketStatus, deleteTicketComment, editTicketComment],
  );
}

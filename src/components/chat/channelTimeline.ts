import type { ChatMsg } from "@/components/chat/transport";
import type { GitTimelineActivity } from "@/lib/gitActivity";

/** A non-chat item that may appear alongside encrypted channel messages. */
export type GitChannelTimelineEntry =
  | { type: "git-ticket-opened"; id: string; createdAt: number; activity: Extract<GitTimelineActivity, { type: "ticket-opened" }> }
  | { type: "git-comment"; id: string; createdAt: number; activity: Extract<GitTimelineActivity, { type: "comment" }> }
  | { type: "git-status"; id: string; createdAt: number; activity: Extract<GitTimelineActivity, { type: "status-change" }> }
  | { type: "git-ci-run"; id: string; createdAt: number; activity: Extract<GitTimelineActivity, { type: "ci-run" }> };

/** A DM disappearing-messages timer change: a centered notice, not a message. */
export interface DmTimerTimelineEntry {
  type: "dm-timer";
  id: string;
  createdAt: number;
  author: string;
  /** In seconds; 0 means off. */
  seconds: number;
}

/**
 * Broader than `ChatTransport`: Git events keep their own Nostr identity, and a
 * DM timer change is conversation state rather than a message.
 */
export type ChannelTimelineEntry =
  | { type: "chat"; id: string; createdAt: number; message: ChatMsg }
  | GitChannelTimelineEntry
  | DmTimerTimelineEntry;

export function isGitTimelineEntry(entry: ChannelTimelineEntry): entry is GitChannelTimelineEntry {
  return entry.type !== "chat" && entry.type !== "dm-timer";
}

export function gitActivityEntry(activity: GitTimelineActivity): GitChannelTimelineEntry {
  if (activity.type === "ticket-opened") return { type: "git-ticket-opened", id: `git:${activity.ticket.id}`, createdAt: activity.createdAt, activity };
  if (activity.type === "comment") return { type: "git-comment", id: `git:${activity.comment.id}`, createdAt: activity.createdAt, activity };
  if (activity.type === "ci-run") return { type: "git-ci-run", id: `git:${activity.run.id}`, createdAt: activity.createdAt, activity };
  return { type: "git-status", id: `git:${activity.status.event.id}`, createdAt: activity.createdAt, activity };
}

/**
 * The pubkey a row is attributed to, for muting. `undefined` only for a row
 * attributable to nobody.
 */
export function timelineEntryAuthor(entry: ChannelTimelineEntry): string | undefined {
  switch (entry.type) {
    case "chat":
      return entry.message.pubkey;
    case "dm-timer":
      return entry.author;
    case "git-ticket-opened":
      return entry.activity.ticket.author;
    case "git-comment":
      return entry.activity.comment.author;
    case "git-status":
      return entry.activity.status.author;
    case "git-ci-run":
      // The coordinator, not a participant, but mutable all the same.
      return entry.activity.run.author;
  }
}

/** Deterministic oldest-first merge. IDs break timestamp ties across sources.
 *  `extra` carries pre-built non-chat entries (e.g. Concord timer notices). */
export function mergeChannelTimeline(chat: readonly ChatMsg[], git: readonly GitTimelineActivity[], extra: readonly ChannelTimelineEntry[] = []): ChannelTimelineEntry[] {
  const entries: ChannelTimelineEntry[] = [
    ...chat.map((message) => ({ type: "chat" as const, id: `chat:${message.id}`, createdAt: message.created_at, message })),
    ...git.map(gitActivityEntry),
    ...extra,
  ];
  const seen = new Set<string>();
  return entries
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
}

/**
 * Whether an entry folds into its predecessor's row. Only adjacent entries
 * group (chat breaks the run): one author's tickets in one repo, comments on
 * one ticket, status changes on one ticket, and CI runs ACROSS workflows (a
 * push fires them all; the per-workflow fold is `groupCIRunsByWorkflow`).
 */
export function isGitContinuation(previous: ChannelTimelineEntry | undefined, entry: ChannelTimelineEntry | undefined): boolean {
  if (!previous || !entry) return false;
  if (previous.type === "git-ticket-opened" && entry.type === "git-ticket-opened") {
    // Type and repo too, so the group's one sentence holds for every ticket.
    return previous.activity.ticket.author === entry.activity.ticket.author
      && previous.activity.ticket.type === entry.activity.ticket.type
      && previous.activity.repository.coordinate === entry.activity.repository.coordinate;
  }
  if (previous.type === "git-comment" && entry.type === "git-comment") {
    return previous.activity.ticket.id === entry.activity.ticket.id;
  }
  if (previous.type === "git-status" && entry.type === "git-status") {
    return previous.activity.ticket.id === entry.activity.ticket.id;
  }
  return previous.type === "git-ci-run" && entry.type === "git-ci-run";
}

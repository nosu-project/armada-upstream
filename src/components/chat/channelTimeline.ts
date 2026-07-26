import type { ChatMsg } from "@/components/chat/transport";
import type { GitTimelineActivity } from "@/lib/gitActivity";

/** A non-chat item that may appear alongside encrypted channel messages. */
export type GitChannelTimelineEntry =
  | { type: "git-ticket-opened"; id: string; createdAt: number; activity: Extract<GitTimelineActivity, { type: "ticket-opened" }> }
  | { type: "git-comment"; id: string; createdAt: number; activity: Extract<GitTimelineActivity, { type: "comment" }> }
  | { type: "git-status"; id: string; createdAt: number; activity: Extract<GitTimelineActivity, { type: "status-change" }> }
  | { type: "git-ci-run"; id: string; createdAt: number; activity: Extract<GitTimelineActivity, { type: "ci-run" }> };

/**
 * A disappearing-messages timer change in a DM thread — Signal's "You set the
 * disappearing message timer to 1 day" row. Not a chat message: it has no
 * author bubble, no reactions and no reply target, just a centered notice.
 */
export interface DmTimerTimelineEntry {
  type: "dm-timer";
  id: string;
  createdAt: number;
  /** Who changed it. */
  author: string;
  /** The timer they set, in seconds; 0 means they turned it off. */
  seconds: number;
}

/**
 * A channel timeline is deliberately broader than `ChatTransport`: Git events
 * keep their own durable Nostr identity and are never adapted into chat rows,
 * and a DM timer change is conversation state rather than a message.
 */
export type ChannelTimelineEntry =
  | { type: "chat"; id: string; createdAt: number; message: ChatMsg }
  | GitChannelTimelineEntry
  | DmTimerTimelineEntry;

/**
 * Whether an entry is Git activity. Channel timelines carry more than one
 * flavour of non-chat entry now (DM timer changes are the other), so a surface
 * that only knows how to render Git rows has to ask rather than assume.
 */
export function isGitTimelineEntry(entry: ChannelTimelineEntry): entry is GitChannelTimelineEntry {
  return entry.type !== "chat" && entry.type !== "dm-timer";
}

export function gitActivityEntry(activity: GitTimelineActivity): GitChannelTimelineEntry {
  if (activity.type === "ticket-opened") return { type: "git-ticket-opened", id: `git:${activity.ticket.id}`, createdAt: activity.createdAt, activity };
  if (activity.type === "comment") return { type: "git-comment", id: `git:${activity.comment.id}`, createdAt: activity.createdAt, activity };
  if (activity.type === "ci-run") return { type: "git-ci-run", id: `git:${activity.run.id}`, createdAt: activity.createdAt, activity };
  return { type: "git-status", id: `git:${activity.status.event.id}`, createdAt: activity.createdAt, activity };
}

/** Deterministic oldest-first merge. IDs break timestamp ties across sources. */
export function mergeChannelTimeline(chat: readonly ChatMsg[], git: readonly GitTimelineActivity[]): ChannelTimelineEntry[] {
  const entries: ChannelTimelineEntry[] = [
    ...chat.map((message) => ({ type: "chat" as const, id: `chat:${message.id}`, createdAt: message.created_at, message })),
    ...git.map(gitActivityEntry),
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

export function isGitContinuation(previous: ChannelTimelineEntry | undefined, entry: ChannelTimelineEntry | undefined): boolean {
  return Boolean(previous?.type === "git-comment" && entry?.type === "git-comment" && previous.activity.ticket.id === entry.activity.ticket.id);
}

/** Git repository roles are intentionally irrelevant to Concord membership. */
export function isCommunityGuest(pubkey: string, members: ReadonlySet<string>): boolean {
  return !members.has(pubkey);
}

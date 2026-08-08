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

/**
 * The pubkey a timeline row is attributed to, whatever kind of row it is.
 *
 * Muting is a statement about a person, not about a message kind, so the one
 * filter in `MessageTimeline` has to be able to ask any entry who it is from —
 * and each variant keeps the author somewhere different (a chat rumor's own
 * `pubkey`, a timer notice's `author`, a Git payload's `author`). Returns
 * `undefined` only for a row genuinely attributable to nobody.
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
      // The coordinator that signed the run, not a participant — but it is a
      // key the user can have muted, and if they did we honour it.
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
 * Whether an entry belongs to the run its predecessor started, and so should
 * be folded into that row instead of taking one of its own.
 *
 * Adjacency does the gating: a chat message between two Git events breaks the
 * run, because the reader's attention did too. What groups is what a reader
 * would summarize as one thing —
 *
 * - tickets one author opened in one repository: one person filing, not one
 *   avatar and one name repeated down the channel;
 * - comments on one ticket: a burst of discussion, read as a thread;
 * - status changes on one ticket: only the last one is the ticket's state, the
 *   rest are a ticket that flapped;
 * - CI runs, ACROSS workflows: a push fires every workflow at once, so
 *   grouping per workflow would interleave three runs that never collapse.
 *   The per-workflow fold happens inside the row (`groupCIRunsByWorkflow`),
 *   where the latest outcome of each is what survives.
 */
export function isGitContinuation(previous: ChannelTimelineEntry | undefined, entry: ChannelTimelineEntry | undefined): boolean {
  if (!previous || !entry) return false;
  if (previous.type === "git-ticket-opened" && entry.type === "git-ticket-opened") {
    // Type and repository too, so the group's one sentence stays true of every
    // ticket under it ("opened 3 issues in armada").
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

/** Git repository roles are intentionally irrelevant to Concord membership. */
export function isCommunityGuest(pubkey: string, members: ReadonlySet<string>): boolean {
  return !members.has(pubkey);
}

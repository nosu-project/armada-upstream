/**
 * Buzz protocol parsing + timeline folding.
 *
 * Pure functions only (unit-tested in protocol.test.ts). The semantics mirror
 * the Buzz desktop client's `formatTimelineMessages.ts` / `threading.ts`:
 *
 *  - kind 5 AND kind 9005 are deletion markers (targets via `e` tags);
 *  - kind 40003 edits replace the target's content and OVERLAY its `imeta`
 *    tags (all non-imeta tags on the original are preserved);
 *  - a message is a THREAD reply iff it carries a NIP-10 *marked* `reply`
 *    `e` tag (unmarked/positional tags do not thread) and no `broadcast` tag;
 *    a `["broadcast","1"]` reply additionally surfaces on the main timeline.
 */

import {
  KIND_BUZZ_DELETE_EVENT,
  KIND_DELETE,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_SYSTEM_MESSAGE,
} from "@/buzz/kinds";

import type { NostrRumor } from "@/lib/nostrRumor";

const HEX64_RE = /^[0-9a-f]{64}$/i;

// ── Threading (NIP-10 marked tags on kind-9 stream messages) ────────────────

export interface BuzzThreadRef {
  /** The immediate parent id (the marked `reply` tag), or null when top-level. */
  parentId: string | null;
  /** The thread root id (marked `root` tag, else the parent), or null. */
  rootId: string | null;
}

/** NIP-10 marked thread reference. Only MARKED tags count (mirrors Buzz). */
export function buzzThreadRef(tags: string[][]): BuzzThreadRef {
  const eventTags = tags.filter((t) => t[0] === "e" && typeof t[1] === "string");
  if (eventTags.length === 0) return { parentId: null, rootId: null };
  const rootTag = eventTags.find((t) => t[3] === "root");
  const replyTag = [...eventTags].reverse().find((t) => t[3] === "reply") ?? null;
  if (!replyTag) return { parentId: null, rootId: null };
  const parentId = replyTag[1] ?? null;
  return { parentId, rootId: rootTag?.[1] ?? parentId };
}

/** Whether a reply is marked to ALSO surface on the main channel timeline. */
export function isBroadcastReply(tags: string[][]): boolean {
  return tags.some((t) => t[0] === "broadcast" && t[1] === "1");
}

/** Whether an event is a thread-only reply (nested; not a timeline row). */
export function isThreadReply(tags: string[][]): boolean {
  return buzzThreadRef(tags).parentId !== null && !isBroadcastReply(tags);
}

/**
 * Build the NIP-10 marked tags for a Buzz thread reply (mirrors buzz-sdk's
 * `buildReplyTags`): `p` the parent author, `h` the channel, and marked
 * `root`/`reply` `e` tags (a direct reply to the root carries a single
 * `reply` tag).
 */
export function buildBuzzReplyTags(
  channelId: string,
  parentAuthor: string,
  parentEventId: string,
  rootEventId: string,
): string[][] {
  const tags: string[][] = [
    ["p", parentAuthor],
    ["h", channelId],
  ];
  if (parentEventId === rootEventId) {
    tags.push(["e", rootEventId, "", "reply"]);
  } else {
    tags.push(["e", rootEventId, "", "root"]);
    tags.push(["e", parentEventId, "", "reply"]);
  }
  return tags;
}

/** The thread root a reply belongs to, resolving through a known parent. */
export function resolveBuzzRootId(parent: NostrRumor): string {
  const ref = buzzThreadRef(parent.tags);
  return ref.rootId ?? parent.id;
}

// ── Deletions & edits ────────────────────────────────────────────────────────

/** Whether a kind is a Buzz deletion marker. */
export function isBuzzDeletionKind(kind: number): boolean {
  return kind === KIND_DELETE || kind === KIND_BUZZ_DELETE_EVENT;
}

/** All valid `e`-tag targets of a deletion event. */
export function deletionTargets(tags: string[][]): string[] {
  return tags
    .filter((t) => t[0] === "e" && typeof t[1] === "string" && HEX64_RE.test(t[1]))
    .map((t) => t[1]);
}

/** The edit/reaction target: the LAST valid `e` tag (mirrors Buzz desktop). */
export function eventTargetId(tags: string[][]): string | undefined {
  for (let i = tags.length - 1; i >= 0; i--) {
    const t = tags[i];
    if (t?.[0] === "e" && typeof t[1] === "string" && HEX64_RE.test(t[1])) return t[1];
  }
  return undefined;
}

/**
 * Overlay an edit's tags onto the original's: swap the original's `imeta`
 * tags for the edit's (an edit carries the FULL new attachment set), keep
 * every non-imeta original tag. Ports Buzz desktop's `applyEditTagOverlay`.
 */
export function applyEditTagOverlay(
  originalTags: string[][],
  editTags: string[][] | undefined,
): string[][] {
  if (!editTags) return originalTags;
  const kept = originalTags.filter((t) => t[0] !== "imeta");
  const imeta = editTags.filter((t) => t[0] === "imeta");
  return [...kept, ...imeta];
}

/** The latest 40003 edit per target id from a raw event window. */
export function collectEdits(events: NostrRumor[], deletedIds: ReadonlySet<string>): Map<string, NostrRumor> {
  const byTarget = new Map<string, NostrRumor>();
  for (const ev of events) {
    if (ev.kind !== KIND_STREAM_MESSAGE_EDIT || deletedIds.has(ev.id)) continue;
    const target = eventTargetId(ev.tags);
    if (!target || deletedIds.has(target)) continue;
    const prev = byTarget.get(target);
    if (!prev || ev.created_at > prev.created_at) byTarget.set(target, ev);
  }
  return byTarget;
}

/** Every id deleted by a kind-5/9005 marker in a raw event window. */
export function collectDeletedIds(events: NostrRumor[]): Set<string> {
  const out = new Set<string>();
  for (const ev of events) {
    if (!isBuzzDeletionKind(ev.kind)) continue;
    for (const id of deletionTargets(ev.tags)) out.add(id);
  }
  return out;
}

// ── Timeline folding ─────────────────────────────────────────────────────────

export interface BuzzFoldedTimeline {
  /** Top-level rows (incl. broadcast replies), ascending by created_at. */
  timeline: NostrRumor[];
  /** Thread replies bucketed by root id, ascending within each thread. */
  repliesByRoot: Map<string, NostrRumor[]>;
  /** Deleted ids (already removed from timeline/replies). */
  deletedIds: Set<string>;
}

/**
 * Fold a raw window of channel events (content + aux kinds mixed) into the
 * rendered shape: deletions applied, latest edit folded into each message
 * (content swap + imeta overlay + an `["edited", ts]` marker tag so the
 * shared row shows its edited state), and thread replies partitioned out of
 * the timeline into per-root buckets.
 */
export function foldBuzzTimeline(events: NostrRumor[], contentKinds: readonly number[]): BuzzFoldedTimeline {
  const contentSet = new Set(contentKinds);
  const deletedIds = collectDeletedIds(events);
  const edits = collectEdits(events, deletedIds);

  // De-dupe by id, newest copy wins (harmless for immutable events).
  const byId = new Map<string, NostrRumor>();
  for (const ev of events) {
    if (contentSet.has(ev.kind) && !deletedIds.has(ev.id)) byId.set(ev.id, ev);
  }

  const timeline: NostrRumor[] = [];
  const repliesByRoot = new Map<string, NostrRumor[]>();
  for (const raw of byId.values()) {
    const edit = edits.get(raw.id);
    const ev: NostrRumor = edit
      ? {
          ...raw,
          content: edit.content,
          tags: [
            ...applyEditTagOverlay(raw.tags, edit.tags).filter((t) => t[0] !== "edited"),
            ["edited", String(edit.created_at)],
          ],
        }
      : raw;
    const ref = buzzThreadRef(ev.tags);
    const isReply = ref.parentId !== null;
    if (!isReply || isBroadcastReply(ev.tags)) {
      timeline.push(ev);
    }
    if (isReply && ref.rootId) {
      const list = repliesByRoot.get(ref.rootId);
      if (list) list.push(ev);
      else repliesByRoot.set(ref.rootId, [ev]);
    }
  }

  timeline.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  for (const list of repliesByRoot.values()) {
    list.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  }
  return { timeline, repliesByRoot, deletedIds };
}

// ── System messages (kind 40099) ────────────────────────────────────────────

export interface BuzzSystemMessage {
  type: string;
  /** Pubkey of who performed the action. */
  actor?: string;
  /** Pubkey the action targeted (member_joined via add, etc.). */
  target?: string;
  topic?: string;
  purpose?: string;
  visibility?: string;
  ttlSeconds?: number;
}

/** Parse a kind-40099 relay-signed system message's JSON content. */
export function parseSystemMessage(event: NostrRumor): BuzzSystemMessage | undefined {
  if (event.kind !== KIND_SYSTEM_MESSAGE) return undefined;
  try {
    const raw = JSON.parse(event.content) as Record<string, unknown>;
    if (typeof raw.type !== "string") return undefined;
    return {
      type: raw.type,
      actor: typeof raw.actor === "string" ? raw.actor : undefined,
      target: typeof raw.target === "string" ? raw.target : undefined,
      topic: typeof raw.topic === "string" ? raw.topic : undefined,
      purpose: typeof raw.purpose === "string" ? raw.purpose : undefined,
      visibility: typeof raw.visibility === "string" ? raw.visibility : undefined,
      ttlSeconds: typeof raw.ttl_seconds === "number" ? raw.ttl_seconds : undefined,
    };
  } catch {
    return undefined;
  }
}

// ── Channels (kind 39000 Buzz extensions) ────────────────────────────────────

export type BuzzChannelType = "stream" | "forum" | "dm" | "workflow";

/**
 * The Buzz channel type from a kind-39000 metadata event's `t` tag. A channel
 * tagged `hidden` with no explicit type is a DM channel (the relay marks DM
 * channels `hidden`).
 */
export function buzzChannelType(event: NostrRumor): BuzzChannelType {
  const t = event.tags.find(([n]) => n === "t")?.[1];
  if (t === "forum" || t === "dm" || t === "workflow" || t === "stream") return t;
  if (event.tags.some(([n]) => n === "hidden")) return "dm";
  return "stream";
}

/** A channel's topic (Buzz 39000 `topic` tag), if any. */
export function buzzChannelTopic(event: NostrRumor): string | undefined {
  return event.tags.find(([n]) => n === "topic")?.[1] || undefined;
}

/** Whether the channel is archived (Buzz 39000 `archived` tag). */
export function buzzChannelArchived(event: NostrRumor): boolean {
  return event.tags.some(([n, v]) => n === "archived" && v === "true");
}

// ── Jobs (43001–43006) ──────────────────────────────────────────────────────

/** Human label for a job-lifecycle kind. */
export function jobKindLabel(kind: number): string {
  switch (kind) {
    case 43001: return "Job requested";
    case 43002: return "Job accepted";
    case 43003: return "Job progress";
    case 43004: return "Job result";
    case 43005: return "Job cancelled";
    case 43006: return "Job error";
    default: return "Job event";
  }
}

// ── Forum votes (45002) ─────────────────────────────────────────────────────

export interface BuzzVoteTally {
  up: number;
  down: number;
  /** The viewer's own vote event (to retract), if any. */
  mine?: { eventId: string; value: "+" | "-" };
}

/**
 * Tally forum votes per target post/comment. One vote per pubkey (the latest
 * wins). Deleted votes must be pre-filtered by the caller.
 */
export function tallyForumVotes(
  votes: NostrRumor[],
  viewer: string | undefined,
): Map<string, BuzzVoteTally> {
  // target → pubkey → latest vote
  const latest = new Map<string, Map<string, NostrRumor>>();
  for (const v of votes) {
    if (v.kind !== KIND_FORUM_VOTE) continue;
    const target = eventTargetId(v.tags);
    if (!target) continue;
    const value = v.content.trim();
    if (value !== "+" && value !== "-") continue;
    let per = latest.get(target);
    if (!per) latest.set(target, (per = new Map()));
    const prev = per.get(v.pubkey);
    if (!prev || v.created_at > prev.created_at) per.set(v.pubkey, v);
  }
  const out = new Map<string, BuzzVoteTally>();
  for (const [target, per] of latest) {
    const tally: BuzzVoteTally = { up: 0, down: 0 };
    for (const v of per.values()) {
      const value = v.content.trim() as "+" | "-";
      if (value === "+") tally.up += 1;
      else tally.down += 1;
      if (viewer && v.pubkey === viewer) tally.mine = { eventId: v.id, value };
    }
    out.set(target, tally);
  }
  return out;
}

// ── Kind helpers used by rows ───────────────────────────────────────────────

/** Whether a kind renders through the standard chat-message row. */
export function isChatLikeKind(kind: number): boolean {
  return (
    kind === KIND_STREAM_MESSAGE ||
    kind === 40001 ||
    kind === 40002 ||
    kind === KIND_FORUM_POST ||
    kind === KIND_FORUM_COMMENT
  );
}

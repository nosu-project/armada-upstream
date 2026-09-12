/**
 * Titled posts and the forum feed — CORD-03 §3.
 *
 * A forum post is an ordinary kind-9 message carrying a `["subject", <title>]`
 * tag (NIP-14, the tag NIP-17 reuses). The `content` is the body and its
 * kind-1111 threaded replies are its comments, so a post is one publish with
 * no partial state, and "is this a post?" is a tag check rather than an
 * inference over structure. A client without forum support renders it as a
 * normal message with a thread under it and loses nothing.
 *
 * The tag marks the MESSAGE; the channel's `view` (`channelView.ts`) only
 * chooses which presentation the channel opens to. A titled post in a chat
 * channel renders with its title in the timeline, and a bare message in a
 * forum channel is timeline chatter behind the feed. Both are well-formed.
 *
 * Everything here is pure: the feed is a different ARRANGEMENT of the same
 * folded output the timeline shows, not a second decode path.
 */

import { KIND_MESSAGE } from "@/concord/lib/kinds";
import { threadSummary, type ChatMsg } from "@/components/chat/transport";

/** The NIP-14 tag a titled post carries. */
export const SUBJECT_TAG = "subject";

/**
 * A title, not a name — so wider than the 64-byte name cap — and bounded so a
 * feed row has a known worst case (CORD-03 §3). Counted as UTF-8.
 */
export const SUBJECT_MAX_BYTES = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8Len(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Cut a string to at most `maxBytes` of UTF-8 without splitting a code point:
 * the decoder is lossy on a partial sequence, and dropping the partial tail is
 * exactly the intended result.
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  const bytes = encoder.encode(s);
  if (bytes.length <= maxBytes) return s;
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) so we cut on a boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/**
 * The post's title, or undefined when the message is not a titled post.
 * Kind 9 only — a threaded reply (1111) is a comment, never a post, whatever
 * tags it carries. Blank titles read as no title; an over-long one is
 * truncated for display, never grounds for dropping the message.
 */
export function subjectOf(msg: { kind: number; tags: string[][] }): string | undefined {
  if (msg.kind !== KIND_MESSAGE) return undefined;
  const raw = msg.tags.find((t) => t[0] === SUBJECT_TAG)?.[1];
  if (typeof raw !== "string") return undefined;
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) return undefined;
  return utf8Len(title) > SUBJECT_MAX_BYTES ? truncateUtf8(title, SUBJECT_MAX_BYTES).trimEnd() : title;
}

/** Whether a message is a titled post (a kind 9 with a usable subject). */
export function isTitledPost(msg: { kind: number; tags: string[][] }): boolean {
  return subjectOf(msg) !== undefined;
}

/**
 * The tags a new post adds to its kind-9 rumor. Throws on a title the spec
 * would truncate rather than silently publishing a clipped one — the composer
 * enforces the same limit so this is the backstop, not the UX.
 */
export function subjectTags(title: string): string[][] {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (!trimmed) throw new Error("A post needs a title.");
  if (utf8Len(trimmed) > SUBJECT_MAX_BYTES) {
    throw new Error(`Titles are limited to ${SUBJECT_MAX_BYTES} bytes.`);
  }
  return [[SUBJECT_TAG, trimmed]];
}

/** Bytes of a draft title, for the composer's remaining-budget hint. */
export function subjectBytes(title: string): number {
  return utf8Len(title.replace(/\s+/g, " ").trim());
}

/** One post as the feed lists it, derived from the timeline and its threads. */
export interface ForumPost {
  /** The post itself (a kind-9 root carrying a subject). */
  root: ChatMsg;
  title: string;
  /** Comments (threaded replies), excluding the root. */
  replyCount: number;
  /** Newest activity in the post — the newest comment, or the post itself. Unix SECONDS. */
  lastActivityAt: number;
  /** Who produced that newest activity (never lights "new" for the reader's own words). */
  lastActivityBy: string;
  /** Distinct commenters, newest-first, for an avatar stack. */
  participants: string[];
  pinned: boolean;
}

export type ForumSort = "active" | "newest";

/**
 * The feed: every titled post in the loaded window, pinned first, then by
 * `sort` — `active` bumps a post whenever a comment lands (forum-style),
 * `newest` orders by when the post was made. Ties break on the lower id so
 * every client lists one order.
 */
export function forumPosts(
  topLevel: readonly ChatMsg[],
  repliesFor: (rootId: string) => readonly ChatMsg[],
  opts: { sort: ForumSort; isPinned?: (id: string) => boolean },
): ForumPost[] {
  const out: ForumPost[] = [];
  for (const root of topLevel) {
    const title = subjectOf(root);
    if (!title) continue;
    const replies = repliesFor(root.id);
    // The transport hands replies oldest-first, which `threadSummary` relies
    // on for the stack's newest-first ORDER (cosmetic). The newest activity
    // drives the sort and the "new" dot, so it is found by scanning rather
    // than read off the last slot: a caller that violates the order costs
    // avatar order, never a post's place in the feed.
    const { participants } = threadSummary(replies as ChatMsg[]);
    let newest: ChatMsg = root;
    for (const r of replies) if (r.created_at > newest.created_at) newest = r;
    out.push({
      root,
      title,
      replyCount: replies.length,
      lastActivityAt: newest.created_at,
      lastActivityBy: newest.pubkey,
      participants,
      pinned: Boolean(opts.isPinned?.(root.id)),
    });
  }
  const keyOf = opts.sort === "active" ? (p: ForumPost) => p.lastActivityAt : (p: ForumPost) => p.root.created_at;
  out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const d = keyOf(b) - keyOf(a);
    if (d !== 0) return d;
    return a.root.id < b.root.id ? -1 : a.root.id > b.root.id ? 1 : 0;
  });
  return out;
}

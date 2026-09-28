/**
 * Titled posts and the forum feed — CORD-03 §3. A forum post is a kind-9 message
 * with a `["subject", <title>]` tag (NIP-14); its kind-1111 replies are the
 * comments. Clients without forum support render a normal message with a thread.
 * The tag marks the MESSAGE; the channel `view` (`channelView.ts`) only picks the
 * default presentation. Pure: the feed rearranges the same folded output.
 */

import { KIND_MESSAGE } from "@/concord/lib/kinds";
import { isImageAttachment, pinAttachmentEntries } from "@/concord/lib/pinAttachments";
import { threadSummary, type ChatMsg } from "@/components/chat/transport";

import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";

/** The NIP-14 tag a titled post carries. */
export const SUBJECT_TAG = "subject";

/** Title cap (wider than the 64-byte name cap), UTF-8 bytes (CORD-03 §3). */
export const SUBJECT_MAX_BYTES = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8Len(s: string): number {
  return encoder.encode(s).length;
}

/** Cut to at most `maxBytes` of UTF-8 without splitting a code point. */
export function truncateUtf8(s: string, maxBytes: number): string {
  const bytes = encoder.encode(s);
  if (bytes.length <= maxBytes) return s;
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) so we cut on a boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/**
 * The post's title, or undefined if not a titled post. Kind 9 only (a 1111 is a
 * comment). Blank reads as none; over-long is truncated, never dropped.
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
 * Tags for a new post's kind-9 rumor. Throws rather than publishing a clipped
 * title (the composer enforces the same limit).
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

/** A feed row's preview image. */
export type ForumImage = EncryptedRef & { spoiler?: boolean };

/**
 * A post's images, in order, for the feed gallery — using the pin extractor's
 * rules (sanitized URLs, no local-network hosts or SVG), since rows render
 * unprompted. Spoilers are kept, to be covered.
 */
export function forumImages(root: { content: string; tags: string[][] }): ForumImage[] {
  return pinAttachmentEntries(root.content, root.tags)
    .filter(isImageAttachment)
    .map((e) => ({
      url: e.url,
      encryption: e.encryption,
      mime: e.mime,
      dim: e.dim,
      blurhash: e.blurhash,
      fallbacks: e.fallbacks,
      spoiler: e.spoiler,
    }));
}

/** One post as the feed lists it, derived from the timeline and its threads. */
export interface ForumPost {
  root: ChatMsg;
  title: string;
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
 * The feed: titled posts in the loaded window, pinned first, then by `sort`
 * (`active` = latest comment, `newest` = post time); ties on lower id.
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
    // Newest activity is found by scanning, not read off the last slot, so an
    // ordering violation only affects avatar order.
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

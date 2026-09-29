import { parseFileMessageTags, parseImetaMap } from "@/lib/imeta";
import { IMAGE_URL_REGEX } from "@/lib/mediaUrls";
import { KIND_DM_FILE } from "@/lib/nip17/protocol";
import { inlineReplyQuoteId } from "@/lib/quoteReply";

import type { ChatMsg } from "@/components/chat/transport";
import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";
import type { ImetaEntry } from "@/lib/imeta";

/**
 * Inline-reply target via NIP-10 marked `e` tags (NIP-29). Concord uses a
 * NIP-C7 `q` tag (see getQuoteReplyToId).
 */
export function getReplyToId(event: ChatMsg): string | undefined {
  const replyTag = event.tags.find(([name, , , marker]) => name === "e" && marker === "reply");
  if (replyTag) return replyTag[1];
  const rootTag = event.tags.find(([name, , , marker]) => name === "e" && marker === "root");
  return rootTag?.[1];
}

/**
 * Concord inline-reply target (NIP-C7 `q`). Concord threads are kind 1111 and
 * never in the timeline, so a `q` on a top-level row is an inline reply.
 */
export function getQuoteReplyToId(event: ChatMsg): string | undefined {
  return inlineReplyQuoteId(event);
}

/**
 * First image attachment as a thumbnail ref. Prefers imeta (carries Concord
 * decryption params), else the first inline image URL.
 */
export function firstImageRef(event: ChatMsg): EncryptedRef | undefined {
  // NIP-17 kind-15 has no imeta; synthesize one from top-level tags.
  if (event.kind === KIND_DM_FILE) {
    const fileEntry = parseFileMessageTags(event.content.trim(), event.tags);
    if (fileEntry && (fileEntry.mime?.startsWith("image/") || IMAGE_URL_REGEX.test(fileEntry.url))) {
      return refOf(fileEntry);
    }
  }
  const imeta = parseImetaMap(event.tags);
  for (const entry of imeta.values()) {
    const isImage = entry.mime?.startsWith("image/") || IMAGE_URL_REGEX.test(entry.url);
    // A spoilered image gets no thumbnail.
    if (isImage) return entry.spoiler ? undefined : refOf(entry);
  }
  const inline = event.content.match(IMAGE_URL_REGEX)?.[0];
  return inline ? { url: inline } : undefined;
}

/** Keeps `dim`/`blurhash` so thumbnails get a sized blur-up placeholder. */
function refOf(entry: ImetaEntry): EncryptedRef {
  return {
    url: entry.url,
    encryption: entry.encryption,
    mime: entry.mime,
    dim: entry.dim,
    blurhash: entry.blurhash,
    fallbacks: entry.fallbacks,
  };
}

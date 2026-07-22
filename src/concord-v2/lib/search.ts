/**
 * Concord V2 message search — the filter model + local matchers.
 *
 * V2 chat is end-to-end encrypted at each channel's stream address, so there is
 * NO relay NIP-50 search to fall back on: the decrypted rumor store is the only
 * searchable corpus. This module defines the structured filter object (mirroring
 * Ditto's search: one filter object → one query-builder → one client-side
 * matcher) and the content/media predicates the store scan applies in memory.
 */

import { parseImetaMap } from "@/lib/imeta";
import { AUDIO_EXTS, IMAGE_URL_REGEX, VIDEO_EXTS } from "@/lib/mediaUrls";

/** A media-attachment facet. `all` disables the media constraint. */
export type SearchMedia2 = "all" | "images" | "videos" | "links" | "none";

/**
 * The structured search filter. `channelIds` empty means "every channel in the
 * community"; `authors` empty means "anyone". The free-text `query` and the
 * `media` facet are applied as in-memory predicates over the store scan.
 */
export interface SearchFilters2 {
  query: string;
  /** Channel idHex allow-list; empty = all channels. */
  channelIds: string[];
  /** Author pubkey allow-list; empty = anyone. */
  authors: string[];
  media: SearchMedia2;
}

export const EMPTY_SEARCH_FILTERS: SearchFilters2 = {
  query: "",
  channelIds: [],
  authors: [],
  media: "all",
};

/**
 * Whether the filters constitute an ACTIVE search (results replace the
 * timeline) rather than the default state. A ≥2-char query, a chosen author, or
 * a media facet activates search; a channel narrowing alone only scopes an
 * otherwise-active search (it must not dump every message in a channel).
 */
export function searchIsActive(f: SearchFilters2): boolean {
  return f.query.trim().length >= 2 || f.authors.length > 0 || f.media !== "all";
}

/** Count of non-default structured facets, for the filter-button badge. */
export function activeFacetCount(f: SearchFilters2): number {
  return (
    (f.channelIds.length > 0 ? 1 : 0) +
    (f.authors.length > 0 ? 1 : 0) +
    (f.media !== "all" ? 1 : 0)
  );
}

// Non-global (`.test`-safe) media-URL probes. The exported VIDEO/AUDIO regexes
// carry the global flag (stateful `lastIndex`), so build local `i`-only copies.
const VIDEO_URL_TEST = new RegExp(`https?:\\/\\/[^\\s]+\\.(${VIDEO_EXTS})(\\?[^\\s]*)?`, "i");
const AUDIO_URL_TEST = new RegExp(`https?:\\/\\/[^\\s]+\\.(${AUDIO_EXTS})(\\?[^\\s]*)?`, "i");
const ANY_URL_TEST = /https?:\/\/\S+/i;

/** Media flags for a message, derived from its imeta tags + inline URLs. */
interface MediaFlags {
  hasImage: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Any URL or attachment at all (a "link"). */
  hasUrl: boolean;
}

function mediaFlags(content: string, tags: string[][]): MediaFlags {
  let hasImage = false;
  let hasVideo = false;
  let hasAudio = false;
  const imeta = parseImetaMap(tags);
  for (const entry of imeta.values()) {
    const mime = entry.mime ?? "";
    if (mime.startsWith("image/") || IMAGE_URL_REGEX.test(entry.url)) hasImage = true;
    else if (mime.startsWith("video/") || VIDEO_URL_TEST.test(entry.url)) hasVideo = true;
    else if (mime.startsWith("audio/") || AUDIO_URL_TEST.test(entry.url)) hasAudio = true;
  }
  if (IMAGE_URL_REGEX.test(content)) hasImage = true;
  if (VIDEO_URL_TEST.test(content)) hasVideo = true;
  if (AUDIO_URL_TEST.test(content)) hasAudio = true;
  const hasUrl = imeta.size > 0 || ANY_URL_TEST.test(content);
  return { hasImage, hasVideo, hasAudio, hasUrl };
}

/** Whether a message satisfies the media facet (`all` always passes). */
export function messageMatchesMedia(content: string, tags: string[][], media: SearchMedia2): boolean {
  if (media === "all") return true;
  const f = mediaFlags(content, tags);
  switch (media) {
    case "images":
      return f.hasImage;
    case "videos":
      return f.hasVideo;
    case "links":
      return f.hasUrl;
    case "none":
      // Plain text: no attachment and no link.
      return !f.hasUrl && !f.hasImage && !f.hasVideo && !f.hasAudio;
    default:
      return true;
  }
}

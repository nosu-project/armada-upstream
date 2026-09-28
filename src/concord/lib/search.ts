/**
 * Concord message search — the filter model + local matchers. Chat is E2EE, so
 * there's no relay NIP-50: the decrypted rumor store is the only corpus.
 */

import { parseImetaMap } from "@/lib/imeta";
import { AUDIO_EXTS, IMAGE_URL_REGEX, VIDEO_EXTS } from "@/lib/mediaUrls";

/** A media-attachment facet. `all` disables the media constraint. */
export type SearchMedia = "all" | "images" | "videos" | "links" | "none";

/** The structured search filter; empty `channelIds`/`authors` mean all/anyone. */
export interface SearchFilters {
  query: string;
  /** Channel idHex allow-list; empty = all channels. */
  channelIds: string[];
  /** Author pubkey allow-list; empty = anyone. */
  authors: string[];
  media: SearchMedia;
}

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
  query: "",
  channelIds: [],
  authors: [],
  media: "all",
};

/**
 * Whether the filters make an ACTIVE search (results replace the timeline): a
 * ≥2-char query, an author, or a media facet. Channel narrowing alone doesn't.
 */
export function searchIsActive(f: SearchFilters): boolean {
  return f.query.trim().length >= 2 || f.authors.length > 0 || f.media !== "all";
}

/** Count of non-default structured facets, for the filter-button badge. */
export function activeFacetCount(f: SearchFilters): number {
  return (
    (f.channelIds.length > 0 ? 1 : 0) +
    (f.authors.length > 0 ? 1 : 0) +
    (f.media !== "all" ? 1 : 0)
  );
}

// `.test`-safe copies: the exported VIDEO/AUDIO regexes are global (stateful `lastIndex`).
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
export function messageMatchesMedia(content: string, tags: string[][], media: SearchMedia): boolean {
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
      return !f.hasUrl && !f.hasImage && !f.hasVideo && !f.hasAudio;
    default:
      return true;
  }
}

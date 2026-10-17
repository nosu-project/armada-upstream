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
  /** Inclusive local-day range as `YYYY-MM-DD`; `""` = unbounded. */
  dateFrom: string;
  dateTo: string;
}

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
  query: "",
  channelIds: [],
  authors: [],
  media: "all",
  dateFrom: "",
  dateTo: "",
};

/**
 * Whether the filters make an ACTIVE search (results replace the timeline): a
 * ≥2-char query, an author, a media facet or a date. Channel narrowing alone doesn't.
 */
export function searchIsActive(f: SearchFilters): boolean {
  return (
    searchText(f.query).length >= 2 ||
    f.authors.length > 0 ||
    f.media !== "all" ||
    !!f.dateFrom ||
    !!f.dateTo
  );
}

/** Count of non-default structured facets, for the filter-button badge. */
export function activeFacetCount(f: SearchFilters): number {
  return (
    (f.channelIds.length > 0 ? 1 : 0) +
    (f.authors.length > 0 ? 1 : 0) +
    (f.media !== "all" ? 1 : 0) +
    (f.dateFrom || f.dateTo ? 1 : 0)
  );
}

// ── Dates ──────────────────────────────────────────────────────────────────

/** A `YYYY-MM-DD` as a local midnight, or null when it isn't a real date. */
function ymdToDate(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(ymd);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(y, mo, d);
  // Rejects rollovers such as 2026-02-31.
  return date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d ? date : null;
}

function dateToYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `ymd` moved by whole days (DST-safe: calendar arithmetic, not milliseconds). */
export function shiftYmd(ymd: string, days: number): string {
  const d = ymdToDate(ymd);
  if (!d) return ymd;
  return dateToYmd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

/** A typed date (`today`, `yesterday`, `YYYY-MM-DD`) as `YYYY-MM-DD`, else null. */
export function parseSearchDate(value: string, now: Date = new Date()): string | null {
  const v = value.trim().toLowerCase();
  if (v === "today") return dateToYmd(now);
  if (v === "yesterday") return dateToYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const d = ymdToDate(v);
  return d ? dateToYmd(d) : null;
}

/** The date range as NIP-01 `since`/`until` seconds, each day taken whole in local time. */
export function searchDateBounds(f: Pick<SearchFilters, "dateFrom" | "dateTo">): {
  since?: number;
  until?: number;
} {
  const out: { since?: number; until?: number } = {};
  const from = f.dateFrom ? ymdToDate(f.dateFrom) : null;
  if (from) out.since = Math.floor(from.getTime() / 1000);
  const to = f.dateTo ? ymdToDate(f.dateTo) : null;
  if (to) {
    const next = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
    out.until = Math.floor(next.getTime() / 1000) - 1;
  }
  return out;
}

export function formatSearchDate(ymd: string): string {
  const d = ymdToDate(ymd);
  return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ymd;
}

// ── Typed tokens (Discord-style `from:` / `in:` / `has:` / dates) ──────────

export type SearchTokenKey = "from" | "in" | "has" | "before" | "after" | "during";

export const SEARCH_TOKEN_KEYS: Array<{ key: SearchTokenKey; hint: string }> = [
  { key: "from", hint: "user" },
  { key: "in", hint: "channel" },
  { key: "has", hint: "link, image or video" },
  { key: "before", hint: "date" },
  { key: "after", hint: "date" },
  { key: "during", hint: "date" },
];

export type SearchDateKey = Extract<SearchTokenKey, "before" | "after" | "during">;

/** `has:` values and the media facet each sets. */
export const HAS_VALUES: Array<{ value: string; media: SearchMedia }> = [
  { value: "link", media: "links" },
  { value: "image", media: "images" },
  { value: "video", media: "videos" },
];

export interface SearchToken {
  /** Span of the whitespace-delimited word around the caret. */
  start: number;
  end: number;
  /** Set when the word is `<known key>:<value>`; otherwise the word is bare. */
  key?: SearchTokenKey;
  value: string;
}

/** The word under the caret, split into a filter key and value when it is one. */
export function tokenAtCaret(text: string, caret: number): SearchToken {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const word = text.slice(start, end);
  const m = /^([a-z]+):(.*)$/i.exec(word);
  const key = m && SEARCH_TOKEN_KEYS.find((k) => k.key === m[1].toLowerCase())?.key;
  return key ? { start, end, key, value: m[2] } : { start, end, value: word };
}

/** `text` without `[start, end)`, keeping one space at the seam. */
export function removeToken(text: string, start: number, end: number): string {
  const before = text.slice(0, start).replace(/\s+$/, "");
  const after = text.slice(end).replace(/^\s+/, "");
  return before && after ? `${before} ${after}` : before + after;
}

/** The facet a date token sets: `before`/`after` exclude the named day, as Discord's do. */
export function dateTokenPatch(
  key: SearchDateKey,
  ymd: string,
): Partial<Pick<SearchFilters, "dateFrom" | "dateTo">> {
  if (key === "before") return { dateTo: shiftYmd(ymd, -1) };
  if (key === "after") return { dateFrom: shiftYmd(ymd, 1) };
  return { dateFrom: ymd, dateTo: ymd };
}

const TOKEN_WORD = /^([a-z]+):/i;

function isFilterWord(word: string): boolean {
  const m = TOKEN_WORD.exec(word);
  return !!m && SEARCH_TOKEN_KEYS.some((k) => k.key === m[1].toLowerCase());
}

/** The query's free text: filter tokens still being typed are not search words. */
export function searchText(query: string): string {
  return query
    .split(/\s+/)
    .filter((w) => w && !isFilterWord(w))
    .join(" ");
}

/** The facet a `has:`/date token's value names, or null when it names none. */
export function tokenPatch(
  key: SearchTokenKey,
  value: string,
  now: Date = new Date(),
): Partial<Pick<SearchFilters, "media" | "dateFrom" | "dateTo">> | null {
  if (key === "has") {
    const v = value.toLowerCase();
    const hit = HAS_VALUES.find((h) => h.value === v || `${h.value}s` === v);
    return hit ? { media: hit.media } : null;
  }
  if (key === "before" || key === "after" || key === "during") {
    const ymd = parseSearchDate(value, now);
    return ymd ? dateTokenPatch(key, ymd) : null;
  }
  return null;
}

/**
 * Folds every finished (whitespace-followed) `has:`/date token into its facet.
 * `from:`/`in:` name people and channels, so only a picked suggestion sets them.
 */
export function resolveTypedTokens(f: SearchFilters, now: Date = new Date()): SearchFilters {
  const words = [...f.query.matchAll(/\S+(?=\s)/g)];
  let next = f;
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    const tok = tokenAtCaret(next.query, w.index! + w[0].length);
    if (!tok.key) continue;
    const patch = tokenPatch(tok.key, tok.value, now);
    if (!patch) continue;
    next = { ...next, ...patch, query: removeToken(next.query, tok.start, tok.end) };
  }
  return next;
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

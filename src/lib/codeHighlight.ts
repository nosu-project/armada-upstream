/**
 * Lazy front door to the syntax highlighter (`highlighter.ts`).
 *
 * The grammars load on the first code block that names a language, and every
 * result is memoized, so a block that re-mounts (virtualized message lists,
 * scroll restoration, a re-opened thread) paints highlighted on its first
 * frame instead of flashing plain text while the grammars are consulted again.
 */
import type { Root } from "hast";

type HighlighterModule = typeof import("./highlighter");

let modulePromise: Promise<HighlighterModule> | null = null;

/** Import the grammars (once per session). */
export function loadHighlighter(): Promise<HighlighterModule> {
  modulePromise ??= import("./highlighter");
  return modulePromise;
}

/** Blocks remembered before the oldest is dropped. */
const CACHE_MAX = 200;
/** `null` is a real answer ("not highlightable"), so misses are `undefined`. */
const cache = new Map<string, Root | null>();

function cacheKey(lang: string, code: string): string {
  // NUL can't appear in a fence's language name, so the key is unambiguous.
  return `${lang}\u0000${code}`;
}

/**
 * The highlighted tree for a block computed earlier this session — `null` if
 * it was looked at and can't be highlighted, `undefined` if never seen.
 */
export function getCachedHighlight(lang: string, code: string): Root | null | undefined {
  return cache.get(cacheKey(lang, code));
}

/**
 * Highlight a block, loading the grammars on first use. Resolves `null` for an
 * unknown language or an oversized block; see `highlightCode`.
 */
export async function highlightAsync(lang: string, code: string): Promise<Root | null> {
  const key = cacheKey(lang, code);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const { highlightCode } = await loadHighlighter();
  const tree = highlightCode(lang, code);
  if (cache.size >= CACHE_MAX) {
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, tree);
  return tree;
}

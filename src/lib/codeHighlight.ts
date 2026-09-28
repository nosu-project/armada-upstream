/**
 * Lazy front door to the syntax highlighter; results are memoized so
 * re-mounted blocks paint highlighted on their first frame.
 */
import type { Root } from "hast";

type HighlighterModule = typeof import("./highlighter");

let modulePromise: Promise<HighlighterModule> | null = null;

export function loadHighlighter(): Promise<HighlighterModule> {
  modulePromise ??= import("./highlighter");
  return modulePromise;
}

const CACHE_MAX = 200;
/** `null` is a real answer ("not highlightable"), so misses are `undefined`. */
const cache = new Map<string, Root | null>();

function cacheKey(lang: string, code: string): string {
  return `${lang}\u0000${code}`;
}

/** Cached tree: `null` = can't be highlighted, `undefined` = never seen. */
export function getCachedHighlight(lang: string, code: string): Root | null | undefined {
  return cache.get(cacheKey(lang, code));
}

/** Highlight a block, loading grammars on first use; `null` for unknown language or oversized. */
export async function highlightAsync(lang: string, code: string): Promise<Root | null> {
  const key = cacheKey(lang, code);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const { highlightCode } = await loadHighlighter();
  const tree = highlightCode(lang, code);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, tree);
  return tree;
}

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Default Blossom media servers used when the user has no kind 10063 server
 * list. Order follows BUD-03's "most trusted first" convention.
 */
export const DEFAULT_BLOSSOM_SERVERS = [
  "https://blossom.primal.net/",
  "https://blossom.band/",
];

/** Parse a kind 10063 Blossom server list event into validated server URLs. */
export function parseBlossomServerList(event: NostrEvent): string[] {
  return event.tags
    .filter(([name]) => name === "server")
    .map(([, url]) => url)
    .filter((url) => {
      try {
        new URL(url);
        return true;
      } catch {
        return false;
      }
    });
}

/** Normalize a Blossom server URL for deduplication. */
function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, "");
}

/** Merge the user's servers with the app defaults, deduplicated, user first. */
export function mergeBlossomServers(userServers: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const url of [...userServers, ...DEFAULT_BLOSSOM_SERVERS]) {
    const normalized = normalizeUrl(url);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(url);
    }
  }
  return merged;
}

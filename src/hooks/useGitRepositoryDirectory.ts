import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import {
  GIT_REPOSITORY_ANNOUNCEMENT_KIND,
  parseGitRepositoryAnnouncement,
  type GitRepositoryAnnouncement,
} from "@/lib/gitActivity";
import { GIT_ANNOUNCEMENT_DISCOVERY_RELAY } from "@/lib/gitRepositoryResolver";

/**
 * The public NIP-34 repository directory: newest announcement per repository
 * from the ngit discovery index. Fetched once and searched client-side —
 * discovery relays don't offer text search, and the whole directory is small.
 * Announcements without activity relays are dropped; they can't be attached.
 */
export function useGitRepositoryDirectory(enabled: boolean) {
  const { nostr } = useNostr();
  return useQuery<GitRepositoryAnnouncement[]>({
    queryKey: ["git", "repository-directory"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(GIT_ANNOUNCEMENT_DISCOVERY_RELAY).query(
        [{ kinds: [GIT_REPOSITORY_ANNOUNCEMENT_KIND], limit: 1_000 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      );
      const newest = new Map<string, GitRepositoryAnnouncement>();
      for (const event of events) {
        const parsed = parseGitRepositoryAnnouncement(event);
        if (!parsed || parsed.relays.length === 0) continue;
        const previous = newest.get(parsed.address.coordinate);
        if (!previous || parsed.createdAt > previous.createdAt) {
          newest.set(parsed.address.coordinate, parsed);
        }
      }
      return [...newest.values()].sort((a, b) => b.createdAt - a.createdAt);
    },
  });
}

/**
 * Rank directory entries against a typed query: exact identifier/name first,
 * then prefix, then substring, then description mentions; newest breaks ties.
 */
export function searchGitRepositories(
  directory: readonly GitRepositoryAnnouncement[],
  query: string,
  limit = 8,
): GitRepositoryAnnouncement[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...directory].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  const scored = directory.flatMap((repository) => {
    const name = repository.name.toLowerCase();
    const identifier = repository.identifier.toLowerCase();
    const description = (repository.description ?? "").toLowerCase();
    const score =
      identifier === q || name === q ? 0
      : identifier.startsWith(q) || name.startsWith(q) ? 1
      : identifier.includes(q) || name.includes(q) ? 2
      : description.includes(q) ? 3
      : -1;
    return score < 0 ? [] : [{ repository, score }];
  });
  return scored
    .sort((a, b) => a.score - b.score || b.repository.createdAt - a.repository.createdAt)
    .map((entry) => entry.repository)
    .slice(0, limit);
}

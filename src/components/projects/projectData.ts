import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Plain data shapes for the shared Projects view. Buzz workspaces fill them
 * from relay-wide NIP-34 scans; Concord communities fill them from the
 * channels' attached repositories. The view itself never queries.
 */

export interface ProjectRepo {
  coord: string;
  owner: string;
  id: string;
  name: string;
  description?: string;
  cloneUrls: string[];
  webUrl?: string;
  contributors: string[];
  createdAt: number;
  /** The repository announcement, when one has been seen. */
  event?: NostrEvent;
  /** Optional origin label (e.g. the channel a repo is attached to). */
  subtitle?: string;
}

export type ProjectWorkKind = "issue" | "pr" | "patch";
export type ProjectWorkStatus = "open" | "merged" | "closed" | "draft" | "resolved";

export interface ProjectWorkItem {
  id: string;
  kind: ProjectWorkKind;
  title: string;
  content: string;
  author: string;
  createdAt: number;
  repoCoord: string | null;
  status: ProjectWorkStatus;
  event: NostrEvent;
  /** Lowercased `t` labels, when the source parses them. */
  labels?: string[];
  /** Known discussion size; hidden when the source doesn't count. */
  commentCount?: number;
  /**
   * Newest comment or status change, absent when the source tracks no
   * discussion. Comment edits keep their original timestamp so a thread does
   * not reorder under readers, which means an edit alone never bumps this.
   */
  updatedAt?: number;
}

export interface ProjectRepoSummary {
  prCount: number;
  issueCount: number;
}

/** How a list is ordered: newest first, or alphabetically. */
export type ProjectSort = "updated" | "name";

/**
 * Universal starting vocabulary, offered only to fill gaps: a repository that
 * has settled on its own words (`enhancement`) should not be nudged toward
 * ours (`feature request`).
 */
export const DEFAULT_LABEL_PRESETS = ["bug", "enhancement", "documentation", "question"] as const;

/**
 * Labels to offer when filing against `repoCoord`: the repository's own, most
 * used first, then presets it hasn't already got a word for.
 */
export function labelSuggestions(
  items: readonly ProjectWorkItem[],
  repoCoord: string | undefined,
  presets: readonly string[] = DEFAULT_LABEL_PRESETS,
): string[] {
  const uses = new Map<string, number>();
  for (const item of items) {
    if (repoCoord && item.repoCoord !== repoCoord) continue;
    for (const label of item.labels ?? []) uses.set(label, (uses.get(label) ?? 0) + 1);
  }
  const own = [...uses.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);
  return [...own, ...presets.filter((preset) => !uses.has(preset))];
}

/** When a work item last saw activity; its opening when nothing followed. */
export function workItemActivityAt(item: ProjectWorkItem): number {
  return Math.max(item.updatedAt ?? 0, item.createdAt);
}

/** Order work items for display; ties break on id so the order is stable. */
export function sortProjectWorkItems(items: readonly ProjectWorkItem[], sort: ProjectSort): ProjectWorkItem[] {
  return [...items].sort((a, b) => (
    sort === "name"
      ? a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
      : workItemActivityAt(b) - workItemActivityAt(a) || a.id.localeCompare(b.id)
  ));
}

/**
 * Every whitespace-separated term must appear somewhere in the haystack, so
 * adding words narrows the result rather than widening it.
 */
function matchesTerms(haystack: readonly (string | undefined)[], query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack.filter(Boolean).join("\n").toLowerCase();
  return terms.every((term) => text.includes(term));
}

/** Free-text match over a work item's title, body, labels and repository. */
export function workItemMatchesQuery(item: ProjectWorkItem, query: string, repoName?: string): boolean {
  return matchesTerms([item.title, item.content, repoName, ...(item.labels ?? [])], query);
}

/** Free-text match over a repository's name, identifier, description and origin. */
export function repoMatchesQuery(repo: ProjectRepo, query: string): boolean {
  return matchesTerms([repo.name, repo.id, repo.description, repo.subtitle], query);
}

/** PR/issue counts bucketed by repo coordinate (`30617:owner:d`). */
export function repoSummaries(items: ProjectWorkItem[]): Map<string, ProjectRepoSummary> {
  const map = new Map<string, ProjectRepoSummary>();
  for (const item of items) {
    if (!item.repoCoord) continue;
    const summary = map.get(item.repoCoord) ?? { prCount: 0, issueCount: 0 };
    if (item.kind === "issue") summary.issueCount += 1;
    else summary.prCount += 1;
    map.set(item.repoCoord, summary);
  }
  return map;
}

/** Local `YYYY-MM-DD` key for a Unix-seconds timestamp (matches the graph). */
export function dayKey(unix: number): string {
  const date = new Date(unix * 1000);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Per-day event counts across repos + work items (the contribution heatmap). */
export function activityByDay(repos: ProjectRepo[], items: ProjectWorkItem[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const repo of repos) {
    const key = dayKey(repo.createdAt);
    merged[key] = (merged[key] ?? 0) + 1;
  }
  for (const item of items) {
    const key = dayKey(item.createdAt);
    merged[key] = (merged[key] ?? 0) + 1;
  }
  return merged;
}

/** Everyone who owns, is tagged on, or has authored activity in a project space. */
export function projectPeople(repos: ProjectRepo[], items: ProjectWorkItem[]): string[] {
  const set = new Set<string>();
  for (const repo of repos) {
    set.add(repo.owner);
    for (const c of repo.contributors) set.add(c);
  }
  for (const item of items) set.add(item.author);
  return [...set];
}

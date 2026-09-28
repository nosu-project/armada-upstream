import type { NostrRumor } from "@/lib/nostrRumor";

/** Plain data shapes for the Projects view (Buzz NIP-34 scans or Concord attached repos). The view never queries. */

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
  event?: NostrRumor;
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
  event: NostrRumor;
  labels?: string[];
  commentCount?: number;
  /** Newest comment or status change. Comment edits keep their timestamp, so an edit never bumps this. */
  updatedAt?: number;
}

export interface ProjectRepoSummary {
  prCount: number;
  issueCount: number;
}

export type ProjectSort = "updated" | "name";

/** Offered only to fill gaps, so a repo's own words (`enhancement`) aren't overridden. */
export const DEFAULT_LABEL_PRESETS = ["bug", "enhancement", "documentation", "question"] as const;

/** Repo's own labels by use, then presets it lacks a word for. */
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

export function workItemActivityAt(item: ProjectWorkItem): number {
  return Math.max(item.updatedAt ?? 0, item.createdAt);
}

/** Ties break on id so the order is stable. */
export function sortProjectWorkItems(items: readonly ProjectWorkItem[], sort: ProjectSort): ProjectWorkItem[] {
  return [...items].sort((a, b) => (
    sort === "name"
      ? a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
      : workItemActivityAt(b) - workItemActivityAt(a) || a.id.localeCompare(b.id)
  ));
}

/** Every whitespace-separated term must match, so more words narrow. */
function matchesTerms(haystack: readonly (string | undefined)[], query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack.filter(Boolean).join("\n").toLowerCase();
  return terms.every((term) => text.includes(term));
}

export function workItemMatchesQuery(item: ProjectWorkItem, query: string, repoName?: string): boolean {
  return matchesTerms([item.title, item.content, repoName, ...(item.labels ?? [])], query);
}

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

export function projectPeople(repos: ProjectRepo[], items: ProjectWorkItem[]): string[] {
  const set = new Set<string>();
  for (const repo of repos) {
    set.add(repo.owner);
    for (const c of repo.contributors) set.add(c);
  }
  for (const item of items) set.add(item.author);
  return [...set];
}

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
}

export interface ProjectRepoSummary {
  prCount: number;
  issueCount: number;
}

/** How a list is ordered: newest first, or alphabetically. */
export type ProjectSort = "updated" | "name";

/** Order work items for display; ties break on id so the order is stable. */
export function sortProjectWorkItems(items: readonly ProjectWorkItem[], sort: ProjectSort): ProjectWorkItem[] {
  return [...items].sort((a, b) => (
    sort === "name"
      ? a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
      : b.createdAt - a.createdAt || a.id.localeCompare(b.id)
  ));
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

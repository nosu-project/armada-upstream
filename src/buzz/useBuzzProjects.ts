import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-34 kinds (Buzz projects = git repos hosted on the relay). */
export const KIND_REPO = 30617;
export const KIND_PATCH = 1617;
export const KIND_PR = 1618;
export const KIND_ISSUE = 1621;
export const STATUS_KINDS = [1630, 1631, 1632, 1633];

export interface BuzzRepo {
  coord: string;
  owner: string;
  id: string;
  name: string;
  description?: string;
  cloneUrls: string[];
  webUrl?: string;
  contributors: string[];
  createdAt: number;
  event: NostrEvent;
}

export type BuzzWorkKind = "issue" | "pr" | "patch";
export type BuzzWorkStatus = "open" | "merged" | "closed" | "draft";

export interface BuzzWorkItem {
  id: string;
  kind: BuzzWorkKind;
  title: string;
  content: string;
  author: string;
  createdAt: number;
  repoCoord: string | null;
  status: BuzzWorkStatus;
  event: NostrEvent;
}

export interface BuzzRepoSummary {
  prCount: number;
  issueCount: number;
}

function parseRepo(event: NostrEvent): BuzzRepo | undefined {
  const d = event.tags.find(([n]) => n === "d")?.[1];
  if (!d) return undefined;
  const cloneTag = event.tags.find(([n]) => n === "clone");
  return {
    coord: `${KIND_REPO}:${event.pubkey}:${d}`,
    owner: event.pubkey,
    id: d,
    name: event.tags.find(([n]) => n === "name")?.[1] || d,
    description: event.tags.find(([n]) => n === "description")?.[1],
    cloneUrls: cloneTag ? cloneTag.slice(1).filter(Boolean) : [],
    webUrl: event.tags.find(([n]) => n === "web")?.[1],
    contributors: event.tags.filter(([n]) => n === "p").map(([, v]) => v).filter(Boolean),
    createdAt: event.created_at,
    event,
  };
}

/** The relay's repo announcements (kind 30617), newest per (owner, d). */
export function useBuzzRepos(relayUrl: string | undefined, enabled = true) {
  const { nostr } = useNostr();
  return useQuery<BuzzRepo[]>({
    queryKey: ["buzz", "repos", relayUrl],
    enabled: Boolean(relayUrl) && enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_REPO], limit: 200 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const newest = new Map<string, NostrEvent>();
      for (const ev of events) {
        const d = ev.tags.find(([n]) => n === "d")?.[1] ?? "";
        const key = `${ev.pubkey}:${d}`;
        const prev = newest.get(key);
        if (!prev || ev.created_at > prev.created_at) newest.set(key, ev);
      }
      return [...newest.values()]
        .map(parseRepo)
        .filter((r): r is BuzzRepo => Boolean(r))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
  });
}

function toStatus(kind: number | undefined): BuzzWorkStatus {
  switch (kind) {
    case 1631: return "merged";
    case 1632: return "closed";
    case 1633: return "draft";
    default: return "open";
  }
}

/**
 * Every issue (1621), patch (1617) and PR (1618) on the relay, each resolved to
 * its latest status (1630–1633). One relay-wide scan feeds the whole Projects
 * view — overview counts, the contribution graph, the activity feed and the
 * per-tab lists — so cards and tabs don't each re-query.
 */
export function useBuzzWorkItems(relayUrl: string | undefined, enabled = true) {
  const { nostr } = useNostr();
  return useQuery<BuzzWorkItem[]>({
    queryKey: ["buzz", "work-items", relayUrl],
    enabled: Boolean(relayUrl) && enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const roots = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_PATCH, KIND_PR, KIND_ISSUE], limit: 500 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const ids = roots.map((r) => r.id);
      const statuses = ids.length
        ? await nostr
            .relay(relayUrl!)
            .query([{ kinds: STATUS_KINDS, "#e": ids, limit: 1000 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[])
        : [];
      // Latest status per root wins (the relay validates who may set it).
      const statusByRoot = new Map<string, NostrEvent>();
      for (const s of statuses) {
        for (const [n, v] of s.tags) {
          if (n !== "e" || !v) continue;
          const prev = statusByRoot.get(v);
          if (!prev || s.created_at > prev.created_at) statusByRoot.set(v, s);
        }
      }
      return roots
        .sort((a, b) => b.created_at - a.created_at)
        .map((ev) => ({
          id: ev.id,
          kind: ev.kind === KIND_ISSUE ? "issue" as const : ev.kind === KIND_PR ? "pr" as const : "patch" as const,
          title:
            ev.tags.find(([n]) => n === "subject")?.[1] ||
            ev.content.split("\n").find((l) => l.trim()) ||
            "(untitled)",
          content: ev.content,
          author: ev.pubkey,
          createdAt: ev.created_at,
          repoCoord: ev.tags.find(([n]) => n === "a")?.[1] ?? null,
          status: toStatus(statusByRoot.get(ev.id)?.kind),
          event: ev,
        }));
    },
  });
}

/** PR/issue counts bucketed by repo coordinate (`30617:owner:d`). */
export function repoSummaries(items: BuzzWorkItem[]): Map<string, BuzzRepoSummary> {
  const map = new Map<string, BuzzRepoSummary>();
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
export function activityByDay(repos: BuzzRepo[], items: BuzzWorkItem[]): Record<string, number> {
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

/** Everyone who owns, is tagged on, or has authored activity in a workspace. */
export function projectPeople(repos: BuzzRepo[], items: BuzzWorkItem[]): string[] {
  const set = new Set<string>();
  for (const repo of repos) {
    set.add(repo.owner);
    for (const c of repo.contributors) set.add(c);
  }
  for (const item of items) set.add(item.author);
  return [...set];
}

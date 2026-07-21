import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, CircleDot, GitBranch, GitMerge, GitPullRequest, Link as LinkIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { writeClipboardText } from "@/lib/clipboard";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-34 kinds (Buzz projects = git repos hosted on the relay). */
const KIND_REPO = 30617;
const KIND_PATCH = 1617;
const KIND_PR = 1618;
const KIND_ISSUE = 1621;
const STATUS_KINDS = [1630, 1631, 1632, 1633];

interface BuzzRepo {
  coord: string;
  owner: string;
  id: string;
  name: string;
  description?: string;
  cloneUrls: string[];
  webUrl?: string;
  event: NostrEvent;
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
    event,
  };
}

/** The relay's repo announcements (kind 30617), newest per (owner, d). */
function useBuzzRepos(relayUrl: string | undefined, enabled: boolean) {
  const { nostr } = useNostr();
  return useQuery<BuzzRepo[]>({
    queryKey: ["buzz", "repos", relayUrl],
    enabled: Boolean(relayUrl) && enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_REPO], limit: 100 }],
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
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

type GitItemStatus = "open" | "merged" | "closed" | "draft";

interface GitItem {
  event: NostrEvent;
  kind: "issue" | "pr" | "patch";
  subject: string;
  status: GitItemStatus;
}

/** Issues + patches/PRs (with resolved statuses) for one repo coordinate. */
function useBuzzRepoItems(relayUrl: string | undefined, coord: string | undefined) {
  const { nostr } = useNostr();
  return useQuery<GitItem[]>({
    queryKey: ["buzz", "repo-items", relayUrl, coord],
    enabled: Boolean(relayUrl && coord),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const roots = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_PATCH, KIND_PR, KIND_ISSUE], "#a": [coord!], limit: 200 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const ids = roots.map((r) => r.id);
      const statuses = ids.length
        ? await nostr
            .relay(relayUrl!)
            .query([{ kinds: STATUS_KINDS, "#e": ids, limit: 500 }], {
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
      const toStatus = (kind: number | undefined): GitItemStatus => {
        switch (kind) {
          case 1631: return "merged";
          case 1632: return "closed";
          case 1633: return "draft";
          default: return "open";
        }
      };
      return roots
        .sort((a, b) => b.created_at - a.created_at)
        .map((ev) => ({
          event: ev,
          kind: ev.kind === KIND_ISSUE ? "issue" as const : ev.kind === KIND_PR ? "pr" as const : "patch" as const,
          subject:
            ev.tags.find(([n]) => n === "subject")?.[1] ||
            ev.content.split("\n").find((l) => l.trim()) ||
            "(untitled)",
          status: toStatus(statusByRoot.get(ev.id)?.kind),
        }));
    },
  });
}

function StatusChip({ status }: { status: GitItemStatus }) {
  const styles: Record<GitItemStatus, string> = {
    open: "bg-success/15 text-success",
    merged: "bg-primary/15 text-primary",
    closed: "bg-destructive/15 text-destructive",
    draft: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", styles[status])}>
      {status}
    </span>
  );
}

function GitItemRow({ item }: { item: GitItem }) {
  const author = useAuthor(item.event.pubkey);
  const name = useScopedDisplayName(item.event.pubkey, author.data?.metadata);
  const Icon = item.kind === "issue" ? CircleDot : item.kind === "pr" ? GitPullRequest : GitMerge;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{item.subject}</span>
      <span className="shrink-0 text-xs text-muted-foreground truncate max-w-24">{name}</span>
      <StatusChip status={item.status} />
    </div>
  );
}

function RepoCard({ relayUrl, repo }: { relayUrl: string; repo: BuzzRepo }) {
  const [open, setOpen] = useState(false);
  const { data: items, isLoading } = useBuzzRepoItems(relayUrl, open ? repo.coord : undefined);

  const issues = useMemo(() => (items ?? []).filter((i) => i.kind === "issue"), [items]);
  const changes = useMemo(() => (items ?? []).filter((i) => i.kind !== "issue"), [items]);

  return (
    <div className="clip-corner-lg border border-border/60 bg-secondary/40 overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-foreground/5 transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <GitBranch className="size-4 shrink-0 text-primary/80" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{repo.name}</div>
          {repo.description && (
            <div className="text-xs text-muted-foreground truncate">{repo.description}</div>
          )}
        </div>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-border/60 pb-2">
          {(repo.cloneUrls.length > 0 || repo.webUrl) && (
            <div className="px-3 pt-2 space-y-1">
              {repo.cloneUrls.map((url) => (
                <button
                  key={url}
                  type="button"
                  className="flex w-full items-center gap-1.5 text-left text-xs font-mono text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    writeClipboardText(url).then(
                      () => toast({ title: "Clone URL copied" }),
                      () => undefined,
                    )}
                  title="Copy clone URL"
                >
                  <LinkIcon className="size-3 shrink-0" />
                  <span className="truncate">{url}</span>
                </button>
              ))}
              {repo.webUrl && (
                <a
                  href={repo.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  <LinkIcon className="size-3 shrink-0" />
                  <span className="truncate">{repo.webUrl}</span>
                </a>
              )}
            </div>
          )}
          {isLoading ? (
            <div className="px-3 pt-2 space-y-1.5">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          ) : (
            <>
              {issues.length > 0 && (
                <>
                  <div className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Issues · {issues.length}
                  </div>
                  {issues.map((item) => <GitItemRow key={item.event.id} item={item} />)}
                </>
              )}
              {changes.length > 0 && (
                <>
                  <div className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Patches & PRs · {changes.length}
                  </div>
                  {changes.map((item) => <GitItemRow key={item.event.id} item={item} />)}
                </>
              )}
              {issues.length === 0 && changes.length === 0 && (
                <p className="px-3 pt-2 text-xs text-muted-foreground">No issues or patches yet.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Read-only view of a Buzz workspace's projects: the relay's NIP-34 repo
 * announcements (kind 30617) with their issues (1621), patches (1617) and
 * PRs (1618), each resolved to its latest status (1630–1633).
 */
export function BuzzProjectsDialog({
  relayUrl,
  open,
  onOpenChange,
}: {
  relayUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: repos, isLoading } = useBuzzRepos(relayUrl, open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title="Projects">
        <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
          {isLoading ? (
            <>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </>
          ) : repos && repos.length > 0 ? (
            repos.map((repo) => <RepoCard key={repo.coord} relayUrl={relayUrl} repo={repo} />)
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No projects on this workspace yet.
            </p>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { BookMarked, Check, ChevronDown, CircleDot, Copy, ExternalLink, GitBranch, GitMerge, GitPullRequest, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { writeClipboardText } from "@/lib/clipboard";
import { relativeTime } from "@/lib/formatTime";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

import type { NostrEvent } from "@nostrify/nostrify";

/** Compact recognition form for a pubkey: `abcd1234…wxyz` (never identity proof). */
function truncatePubkey(pubkey: string): string {
  return pubkey.length <= 12 ? pubkey : `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

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
  contributors: string[];
  createdAt: number;
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
    contributors: event.tags.filter(([n]) => n === "p").map(([, v]) => v).filter(Boolean),
    createdAt: event.created_at,
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
        .sort((a, b) => b.createdAt - a.createdAt);
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

/** An author's avatar with a name tooltip (Buzz's People roster item). */
function PubkeyAvatar({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  const picture = author.data?.metadata?.picture;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar className="size-8 border border-border/60">
          <AvatarImage src={picture} alt={name} />
          <AvatarFallback className="text-[10px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

/** A clone URL in a bordered box with a click-to-copy affordance. */
function CopyableUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    writeClipboardText(url).then(
      () => {
        setCopied(true);
        toast({ title: "Clone URL copied" });
        setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };
  return (
    <div className="flex items-center gap-2 clip-corner-lg border border-border/60 bg-secondary/40 px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-sm text-foreground">{url}</code>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Copy clone URL"
      >
        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
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
    <div className="flex items-center gap-2 py-1.5 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{item.subject}</span>
      <span className="shrink-0 text-xs text-muted-foreground truncate max-w-24">{name}</span>
      <StatusChip status={item.status} />
    </div>
  );
}

/**
 * A repository row (Buzz's RepoListItem): icon + name + "Public" badge, a
 * two-line description, then owner + updated-time metadata. Expands in place to
 * reveal clone URLs, an optional web link and the repo's issues/patches/PRs —
 * Armada has no HTTP git browser, so the NIP-34 activity stands in for Buzz's
 * code/commits detail tabs.
 */
function RepoListItem({ relayUrl, repo }: { relayUrl: string; repo: BuzzRepo }) {
  const [open, setOpen] = useState(false);
  const { data: items, isLoading } = useBuzzRepoItems(relayUrl, open ? repo.coord : undefined);
  const issues = useMemo(() => (items ?? []).filter((i) => i.kind === "issue"), [items]);
  const changes = useMemo(() => (items ?? []).filter((i) => i.kind !== "issue"), [items]);

  // Validate the web link scheme to prevent javascript: URLs.
  const safeWebUrl = useMemo(() => {
    if (!repo.webUrl) return null;
    try {
      return /^https?:$/.test(new URL(repo.webUrl).protocol) ? repo.webUrl : null;
    } catch {
      return null;
    }
  }, [repo.webUrl]);

  return (
    <div className="py-5">
      {/* Row 1: icon + name (toggles expand) + badge + chevron */}
      <div className="flex items-center gap-2">
        <BookMarked className="size-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-lg font-semibold text-foreground underline-offset-4 hover:text-foreground/70 hover:underline"
        >
          {repo.name}
        </button>
        <Badge variant="outline" className="ml-1 border-border/60 text-muted-foreground">
          Public
        </Badge>
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </div>

      {/* Row 2: description */}
      {repo.description && (
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{repo.description}</p>
      )}

      {/* Row 3: metadata */}
      <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default font-mono">{truncatePubkey(repo.owner)}</span>
          </TooltipTrigger>
          <TooltipContent>{repo.owner}</TooltipContent>
        </Tooltip>
        <span>Updated {relativeTime(repo.createdAt)}</span>
      </div>

      {/* Expanded: clone + web + activity */}
      {open && (
        <div className="mt-4 space-y-5">
          {repo.cloneUrls.length > 0 && (
            <div>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Clone
              </h3>
              <div className="space-y-2">
                {repo.cloneUrls.map((url) => <CopyableUrl key={url} url={url} />)}
              </div>
            </div>
          )}

          {safeWebUrl && (
            <Button variant="outline" size="sm" className="gap-2" asChild>
              <a href={safeWebUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
                View on web
              </a>
            </Button>
          )}

          {isLoading ? (
            <div className="space-y-1.5">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          ) : (
            <>
              {issues.length > 0 && (
                <div>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Issues · {issues.length}
                  </h3>
                  <div className="divide-y divide-border/60">
                    {issues.map((item) => <GitItemRow key={item.event.id} item={item} />)}
                  </div>
                </div>
              )}
              {changes.length > 0 && (
                <div>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Patches &amp; PRs · {changes.length}
                  </h3>
                  <div className="divide-y divide-border/60">
                    {changes.map((item) => <GitItemRow key={item.event.id} item={item} />)}
                  </div>
                </div>
              )}
              {issues.length === 0 && changes.length === 0 && (
                <p className="text-xs text-muted-foreground">No issues or patches yet.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Right-hand roster of everyone who owns or contributes to a repo here. */
function PeopleSidebar({ repos }: { repos: BuzzRepo[] }) {
  const pubkeys = useMemo(() => {
    const set = new Set<string>();
    for (const repo of repos) {
      set.add(repo.owner);
      for (const c of repo.contributors) set.add(c);
    }
    return [...set];
  }, [repos]);

  if (pubkeys.length === 0) return null;

  const visible = pubkeys.slice(0, 20);
  const overflow = pubkeys.length - visible.length;

  return (
    <aside className="hidden w-64 shrink-0 border-l border-border/60 pl-8 lg:block">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Users className="size-4" />
        People
      </h3>
      <div className="flex flex-wrap gap-2">
        {visible.map((pk) => <PubkeyAvatar key={pk} pubkey={pk} />)}
      </div>
      {overflow > 0 && (
        <span className="mt-2 block text-xs text-muted-foreground">{pubkeys.length} people</span>
      )}
    </aside>
  );
}

function ListItemSkeleton() {
  return (
    <div className="py-5">
      <div className="flex items-center gap-2">
        <Skeleton className="size-4 shrink-0" />
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-5 w-14" />
      </div>
      <Skeleton className="mt-2 h-4 w-3/4" />
      <div className="mt-2 flex gap-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}

type SortOrder = "newest" | "oldest" | "name";

/**
 * Read-only view of a Buzz workspace's projects: the relay's NIP-34 repo
 * announcements (kind 30617) with their issues (1621), patches (1617) and
 * PRs (1618), each resolved to its latest status (1630–1633). Modeled on the
 * Buzz web client's Repositories page — a searchable/sortable list with a
 * People roster — using Armada's theme tokens.
 */
export function BuzzProjectsList({ relayUrl }: { relayUrl: string }) {
  const { data: repos, isLoading } = useBuzzRepos(relayUrl, true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOrder>("newest");

  const filtered = useMemo(() => {
    if (!repos) return [];
    const term = search.toLowerCase();
    const result = repos.filter(
      (r) =>
        r.name.toLowerCase().includes(term) ||
        (r.description ?? "").toLowerCase().includes(term),
    );
    switch (sort) {
      case "newest":
        return result.sort((a, b) => b.createdAt - a.createdAt);
      case "oldest":
        return result.sort((a, b) => a.createdAt - b.createdAt);
      case "name":
        return result.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    }
  }, [repos, search, sort]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 gap-8 px-4 py-6">
      <div className="min-w-0 flex-1">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-foreground">
          <BookMarked className="size-4" /> Repositories
        </h2>

        {/* Search + sort */}
        <div className="mb-4 flex gap-3">
          <Input
            placeholder="Find a repository…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOrder)}
            aria-label="Sort repositories"
            className="clip-corner-lg border border-input bg-background px-3 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name">Name</option>
          </select>
        </div>

        {isLoading ? (
          <div className="divide-y divide-border/60">
            {["a", "b", "c", "d", "e"].map((k) => <ListItemSkeleton key={k} />)}
          </div>
        ) : filtered.length > 0 ? (
          <div className="divide-y divide-border/60">
            {filtered.map((repo) => <RepoListItem key={repo.coord} relayUrl={relayUrl} repo={repo} />)}
          </div>
        ) : (repos?.length ?? 0) > 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-secondary">
              <GitBranch className="size-7 text-muted-foreground" />
            </div>
            <h2 className="mt-4 text-lg font-semibold text-foreground">No matching repositories</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">Try adjusting your search term.</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-secondary">
              <BookMarked className="size-7 text-muted-foreground" />
            </div>
            <h2 className="mt-4 text-lg font-semibold text-foreground">This workspace is empty</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Repositories pushed to this workspace will show up here.
            </p>
          </div>
        )}
      </div>

      {repos && repos.length > 0 && <PeopleSidebar repos={repos} />}
    </div>
  );
}

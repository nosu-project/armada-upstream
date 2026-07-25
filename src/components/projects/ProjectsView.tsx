import { CircleDot, Copy, ExternalLink, FolderGit2, GitMerge, GitPullRequest, LayoutGrid, List, MessageCircle, Users, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { writeClipboardText } from "@/lib/clipboard";
import { relativeTime } from "@/lib/formatTime";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

import {
  activityByDay,
  projectPeople,
  repoSummaries,
  sortProjectWorkItems,
  workItemActivityAt,
  type ProjectRepo,
  type ProjectRepoSummary,
  type ProjectSort,
  type ProjectWorkItem,
  type ProjectWorkKind,
} from "@/components/projects/projectData";

type Filter = "all" | "repositories" | "prs" | "issues";
type ViewMode = "grid" | "list";

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Resolve a pubkey to its scoped display name. */
function useName(pubkey: string): string {
  const author = useAuthor(pubkey);
  return useScopedDisplayName(pubkey, author.data?.metadata);
}

function AuthorName({ pubkey }: { pubkey: string }) {
  const name = useName(pubkey);
  return (
    <span className="font-medium text-foreground/80">
      <DisplayName pubkey={pubkey} name={name} />
    </span>
  );
}

function PersonAvatar({ pubkey, size = "size-7" }: { pubkey: string; size?: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  const picture = author.data?.metadata?.picture;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar className={cn(size, "border border-border/60")}>
          <AvatarImage src={picture} alt={name} />
          <AvatarFallback className="text-[10px]">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent>
        <DisplayName pubkey={pubkey} name={name} />
      </TooltipContent>
    </Tooltip>
  );
}

function PeopleStack({ pubkeys }: { pubkeys: string[] }) {
  const visible = pubkeys.slice(0, 5);
  const remaining = pubkeys.length - visible.length;
  if (visible.length === 0) return null;
  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((pk, i) => (
        <span key={pk} className="relative inline-flex ring-2 ring-card rounded-full" style={{ zIndex: visible.length - i }}>
          <PersonAvatar pubkey={pk} size="size-6" />
        </span>
      ))}
      {remaining > 0 && (
        <span className="relative z-0 flex h-6 min-w-6 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold text-muted-foreground ring-2 ring-card">
          +{remaining}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contribution graph (GitHub-style activity heatmap for the last 26 weeks)
// ---------------------------------------------------------------------------

const DAYS_PER_WEEK = 7;
const LEVEL_CLASSES = [
  "bg-muted/40",
  "bg-primary/25",
  "bg-primary/50",
  "bg-primary/75",
  "bg-primary",
];
const LEVEL_LABELS = ["No activity", "1–2 events", "3–5 events", "6–9 events", "10+ events"];

function graphDayKey(date: Date) {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function levelFor(count: number) {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

function buildWeeks(today: Date, weekCount: number) {
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - today.getDay() - (weekCount - 1) * DAYS_PER_WEEK,
  );
  return Array.from({ length: weekCount }, (_, w) =>
    Array.from({ length: DAYS_PER_WEEK }, (_, d) => {
      const date = new Date(start);
      date.setDate(start.getDate() + w * DAYS_PER_WEEK + d);
      return date;
    }),
  );
}

const MIN_LABEL_GAP = 3;
function monthLabels(weeks: Date[][]) {
  let lastLabeled = -MIN_LABEL_GAP;
  return weeks.map((week, index) => {
    const isNewMonth = index === 0 || week[0].getMonth() !== weeks[index - 1][0].getMonth();
    if (!isNewMonth || index - lastLabeled < MIN_LABEL_GAP) return "";
    lastLabeled = index;
    return week[0].toLocaleDateString(undefined, { month: "short" });
  });
}

function ContributionLegend() {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground">Less</span>
      {LEVEL_CLASSES.map((levelClass, level) => (
        <Tooltip key={levelClass}>
          <TooltipTrigger asChild>
            <span className={cn("size-2.5 rounded", levelClass)} />
          </TooltipTrigger>
          <TooltipContent>{LEVEL_LABELS[level]}</TooltipContent>
        </Tooltip>
      ))}
      <span className="text-[10px] text-muted-foreground">More</span>
    </div>
  );
}

function ContributionGraph({ data }: { data: Record<string, number> }) {
  const today = new Date();
  const weeks = buildWeeks(today, 26);
  const labels = monthLabels(weeks);
  const gridTemplateColumns = `repeat(${weeks.length}, minmax(0, 1fr))`;
  const todayKey = graphDayKey(today);
  return (
    <div className="space-y-2">
      <div className="grid gap-1" style={{ gridTemplateColumns }}>
        {labels.map((label, index) => (
          <span
            className="overflow-visible whitespace-nowrap text-[10px] font-medium text-muted-foreground"
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size grid
            key={index}
          >
            {label}
          </span>
        ))}
      </div>
      <div className="grid grid-flow-col grid-rows-7 gap-1" style={{ gridTemplateColumns }}>
        {weeks.map((week) =>
          week.map((day) => {
            const key = graphDayKey(day);
            if (key > todayKey) {
              return <span aria-hidden key={key} className="aspect-square rounded-[22%] border border-border/40" />;
            }
            const count = data[key] ?? 0;
            const dateLabel = day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
            return (
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <span className={cn("aspect-square w-full rounded-[22%]", LEVEL_CLASSES[levelFor(count)])} />
                </TooltipTrigger>
                <TooltipContent>
                  {count > 0 ? `${count} ${count === 1 ? "event" : "events"} · ${dateLabel}` : `No activity · ${dateLabel}`}
                </TooltipContent>
              </Tooltip>
            );
          }),
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Work-item visuals
// ---------------------------------------------------------------------------

const WORK_VISUALS: Record<ProjectWorkKind, { icon: typeof CircleDot; badge: string; icclass: string }> = {
  issue: { icon: CircleDot, badge: "bg-orange-500/10", icclass: "text-orange-500" },
  pr: { icon: GitPullRequest, badge: "bg-success/10", icclass: "text-success" },
  patch: { icon: GitMerge, badge: "bg-primary/10", icclass: "text-primary" },
};

function WorkItemIcon({ kind, className }: { kind: ProjectWorkKind; className?: string }) {
  const v = WORK_VISUALS[kind];
  const Icon = v.icon;
  return (
    <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full ring-1 ring-border/60", v.badge, className)}>
      <Icon className={cn("size-3", v.icclass)} />
    </span>
  );
}

const STATUS_STYLES: Record<ProjectWorkItem["status"], string> = {
  open: "bg-success/15 text-success",
  merged: "bg-primary/15 text-primary",
  resolved: "bg-primary/15 text-primary",
  closed: "bg-destructive/15 text-destructive",
  draft: "bg-muted text-muted-foreground",
};

function StatusChip({ status }: { status: ProjectWorkItem["status"] }) {
  return (
    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize", STATUS_STYLES[status])}>
      {status}
    </span>
  );
}

/** A feed/list row for a single issue / patch / PR. */
function WorkItemRow({ item, repoName, onOpen, onLabelClick }: { item: ProjectWorkItem; repoName?: string; onOpen?: () => void; onLabelClick?: (label: string) => void }) {
  const Comp = onOpen ? "button" : "article";
  const labels = item.labels ?? [];
  // Rows are ordered by last activity, so a stale opening date beside a
  // freshly bumped item would read as a sorting bug.
  const activityAt = workItemActivityAt(item);
  const bumped = activityAt > item.createdAt;
  return (
    <Comp
      {...(onOpen ? { type: "button" as const, onClick: onOpen } : {})}
      className={cn(
        "flex min-w-0 items-center justify-between gap-3 p-3 transition-colors hover:bg-foreground/[0.03]",
        onOpen && "w-full text-left",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <WorkItemIcon kind={item.kind} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-semibold leading-5 text-foreground">{item.title}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-4 text-muted-foreground">
            {repoName && <span className="truncate">{repoName}</span>}
            {repoName && <span aria-hidden>·</span>}
            {bumped ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>updated {relativeTime(activityAt)}</span>
                </TooltipTrigger>
                <TooltipContent>Opened {relativeTime(item.createdAt)}</TooltipContent>
              </Tooltip>
            ) : (
              <span>{relativeTime(item.createdAt)}</span>
            )}
            <span aria-hidden>·</span>
            <span>by <AuthorName pubkey={item.author} /></span>
            {labels.slice(0, 3).map((label) => (
              // Plain spans: the row is already a button, so a nested control
              // would be invalid. Clicking is a pointer shortcut; the status
              // filter bar remains the accessible filtering surface.
              <span
                key={label}
                onClick={onLabelClick ? (e) => { e.stopPropagation(); onLabelClick(label); } : undefined}
                className={cn(
                  "rounded-full border border-border/60 px-1.5 py-px text-[10px]",
                  onLabelClick && "cursor-pointer transition-colors hover:border-primary/50 hover:text-foreground",
                )}
              >
                {label}
              </span>
            ))}
            {labels.length > 3 && <span className="text-[10px]">+{labels.length - 3}</span>}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {(item.commentCount ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <MessageCircle className="size-3.5" />
            {item.commentCount}
          </span>
        )}
        <StatusChip status={item.status} />
      </div>
    </Comp>
  );
}

// ---------------------------------------------------------------------------
// Repository card / row
// ---------------------------------------------------------------------------

function RepoIcon() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
      <FolderGit2 className="size-[1.125rem] text-muted-foreground" />
    </span>
  );
}

function CloneButton({ url }: { url: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label="Copy clone URL"
          onClick={() =>
            writeClipboardText(url).then(() => toast({ title: "Clone URL copied" }), () => undefined)}
        >
          <Copy className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Copy clone URL</TooltipContent>
    </Tooltip>
  );
}

function safeWeb(webUrl?: string): string | null {
  if (!webUrl) return null;
  try {
    return /^https?:$/.test(new URL(webUrl).protocol) ? webUrl : null;
  } catch {
    return null;
  }
}

/** Segmented PRs/issues distribution bar. */
function ActivityBar({ summary }: { summary: ProjectRepoSummary }) {
  const items = [
    { count: summary.prCount, bar: "bg-primary", label: summary.prCount === 1 ? "PR" : "PRs" },
    { count: summary.issueCount, bar: "bg-orange-500", label: summary.issueCount === 1 ? "issue" : "issues" },
  ];
  const total = items.reduce((s, i) => s + i.count, 0);
  return (
    <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted/60">
      {total > 0
        ? items.filter((i) => i.count > 0).map((i) => (
            <Tooltip key={i.bar}>
              <TooltipTrigger asChild>
                <div className={cn("h-full", i.bar)} style={{ width: `${(i.count / total) * 100}%` }} />
              </TooltipTrigger>
              <TooltipContent>
                <span className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", i.bar)} />
                  {i.count} {i.label}
                </span>
              </TooltipContent>
            </Tooltip>
          ))
        : null}
    </div>
  );
}

function StatsRow({ summary }: { summary: ProjectRepoSummary }) {
  return (
    <div className="flex items-center gap-x-3 text-xs leading-4 text-muted-foreground">
      <span className="flex items-center gap-1">
        <GitPullRequest className="size-3.5 shrink-0 text-primary" />
        <span className="font-medium text-foreground">{summary.prCount}</span> {summary.prCount === 1 ? "PR" : "PRs"}
      </span>
      <span className="flex items-center gap-1">
        <CircleDot className="size-3.5 shrink-0 text-orange-500" />
        <span className="font-medium text-foreground">{summary.issueCount}</span> {summary.issueCount === 1 ? "issue" : "issues"}
      </span>
    </div>
  );
}

function RepoCard({ repo, summary, people }: { repo: ProjectRepo; summary: ProjectRepoSummary; people: string[] }) {
  const web = safeWeb(repo.webUrl);
  return (
    <Card className="relative flex min-h-44 flex-col overflow-hidden border-border/60 bg-card shadow-none transition-colors hover:bg-foreground/[0.02]">
      <div className="flex min-w-0 items-center justify-between gap-3 px-4 pt-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <RepoIcon />
          <div className="min-w-0 flex-1">
            <span className="block min-w-0 truncate text-sm font-semibold text-foreground">{repo.name}</span>
            {repo.subtitle && <span className="block min-w-0 truncate text-xs text-muted-foreground">{repo.subtitle}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="whitespace-nowrap text-xs text-muted-foreground/70">{relativeTime(repo.createdAt)}</span>
          {web && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" asChild>
                  <a href={web} target="_blank" rel="noopener noreferrer" aria-label="View on web">
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>View on web</TooltipContent>
            </Tooltip>
          )}
          {repo.cloneUrls[0] && <CloneButton url={repo.cloneUrls[0]} />}
        </div>
      </div>

      <p className="line-clamp-2 min-h-10 px-4 py-2 text-sm text-muted-foreground">
        {repo.description || "A shared space for git work."}
      </p>

      <div className="flex items-center px-4 pb-1">
        <PeopleStack pubkeys={people} />
      </div>

      <div className="mt-auto">
        <div className="flex min-w-0 items-center px-4 pb-2 pt-1">
          <StatsRow summary={summary} />
        </div>
        <div className="px-4 pb-3">
          <ActivityBar summary={summary} />
        </div>
      </div>
    </Card>
  );
}

/**
 * The denser repository layout. Its columns stack rather than compete for one
 * line: viewport breakpoints would keep every column mounted inside a narrow
 * community pane and crush the repository name — the one thing the row exists
 * to show — to zero width.
 */
function RepoRow({ repo, summary, people }: { repo: ProjectRepo; summary: ProjectRepoSummary; people: string[] }) {
  const web = safeWeb(repo.webUrl);
  return (
    <div className="flex min-w-0 items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-foreground/[0.03]">
      <RepoIcon />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{repo.name}</span>
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground/70">{relativeTime(repo.createdAt)}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {repo.subtitle ? `${repo.subtitle} · ` : ""}
          {repo.description || "A shared space for git work."}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatsRow summary={summary} />
          <div className="w-20 shrink-0"><ActivityBar summary={summary} /></div>
          <PeopleStack pubkeys={people} />
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        {web && (
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" asChild>
            <a href={web} target="_blank" rel="noopener noreferrer" aria-label="View on web">
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
        )}
        {repo.cloneUrls[0] && <CloneButton url={repo.cloneUrls[0]} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs, stat pills, overview
// ---------------------------------------------------------------------------

const TABS: Array<{ label: string; value: Filter }> = [
  { label: "Overview", value: "all" },
  { label: "Repositories", value: "repositories" },
  { label: "Pull Requests", value: "prs" },
  { label: "Issues", value: "issues" },
];

function Tabs({ filter, onChange }: { filter: Filter; onChange: (f: Filter) => void }) {
  return (
    <div className="flex h-[3.25rem] items-stretch gap-1 overflow-x-auto border-b border-border/60 scrollbar-none [&::-webkit-scrollbar]:hidden">
      {TABS.map((tab) => {
        const active = filter === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => onChange(tab.value)}
            aria-pressed={active}
            className={cn(
              "relative shrink-0 px-3 text-base leading-5 tracking-tight transition-colors",
              "after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-current after:transition-opacity after:content-['']",
              active
                ? "font-semibold text-foreground after:opacity-100"
                : "text-muted-foreground hover:text-foreground after:opacity-0 hover:after:opacity-100",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function StatPill({ count, icon: Icon, label, onClick }: {
  count: number;
  icon: typeof FolderGit2;
  label: string;
  onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn(
        "flex flex-col clip-corner-lg border border-border/60 bg-card px-3.5 py-3 text-left",
        onClick && "transition-colors hover:bg-foreground/[0.03]",
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className="size-3.5 text-muted-foreground/70" />
      </span>
      <span className="mt-auto pt-4 text-4xl font-semibold leading-none tracking-tight text-foreground">{count}</span>
    </Comp>
  );
}

function Overview({
  repos,
  items,
  people,
  onSelect,
  onOpenItem,
}: {
  repos: ProjectRepo[];
  items: ProjectWorkItem[];
  people: string[];
  onSelect: (f: Filter) => void;
  onOpenItem?: (item: ProjectWorkItem) => void;
}) {
  const graph = useMemo(() => activityByDay(repos, items), [repos, items]);
  const prCount = items.filter((i) => i.kind !== "issue").length;
  const issueCount = items.filter((i) => i.kind === "issue").length;
  const repoNameByCoord = useMemo(() => new Map(repos.map((r) => [r.coord, r.name])), [repos]);
  // "Recent activity" means exactly that: a long-quiet issue that just got a
  // comment belongs above a newer one nobody has touched.
  const feed = useMemo(() => sortProjectWorkItems(items, "updated").slice(0, 20), [items]);

  return (
    <div className="space-y-6">
      {/* Stat pills */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr))]">
        <StatPill count={repos.length} icon={FolderGit2} label="Repositories" onClick={() => onSelect("repositories")} />
        <StatPill count={prCount} icon={GitPullRequest} label="Pull requests" onClick={() => onSelect("prs")} />
        <StatPill count={issueCount} icon={CircleDot} label="Issues" onClick={() => onSelect("issues")} />
        <StatPill count={people.length} icon={Users} label="People" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* Activity feed */}
        <section className="min-w-0 space-y-3">
          <h3 className="text-base font-semibold text-foreground">Recent activity</h3>
          {feed.length > 0 ? (
            <div className="clip-corner-lg border border-border/60 bg-card divide-y divide-border/60">
              {feed.map((item) => (
                <WorkItemRow
                  key={item.id}
                  item={item}
                  repoName={item.repoCoord ? repoNameByCoord.get(item.repoCoord) : undefined}
                  onOpen={onOpenItem && (() => onOpenItem(item))}
                />
              ))}
            </div>
          ) : (
            <p className="clip-corner-lg border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
              No activity yet.
            </p>
          )}
        </section>

        {/* Rail: people + contribution graph */}
        <div className="min-w-0 space-y-6">
          <section className="space-y-3">
            <h3 className="text-base font-semibold text-foreground">People</h3>
            {people.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {people.slice(0, 18).map((pk) => <PersonAvatar key={pk} pubkey={pk} />)}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No people yet.</p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">Contribution activity</h3>
            <ContributionGraph data={graph} />
            <ContributionLegend />
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading / empty
// ---------------------------------------------------------------------------

// The view renders inside panes narrower than the viewport (a community's main
// area), so column counts derive from available width, not viewport breakpoints.
const CARD_GRID = "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(20rem,1fr))]";

function CardsSkeleton() {
  return (
    <div className={CARD_GRID}>
      {["a", "b", "c", "d"].map((k) => <Skeleton key={k} className="h-44 w-full" />)}
    </div>
  );
}

function FilteredOutNotice({ onShowAll }: { onShowAll: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
      <p className="text-sm text-muted-foreground">Nothing matches the current filters.</p>
      <Button variant="outline" size="sm" onClick={onShowAll}>Show all</Button>
    </div>
  );
}

function EmptyState({ icon: Icon, title, hint }: { icon: typeof FolderGit2; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-20 text-center">
      <Icon className="size-10 text-muted-foreground/40" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

/**
 * The shared Projects surface: tabbed Overview / Repositories / Pull Requests /
 * Issues, a stat-pill summary, a GitHub-style contribution graph, a people
 * roster and an activity feed. Purely presentational — callers supply the
 * repos and work items (Buzz from relay-wide NIP-34 scans, Concord from the
 * community's attached repositories) and optionally receive row clicks.
 */
export function ProjectsView({
  repos,
  items: workItems,
  isLoading,
  intro = "Browse this workspace's repositories and activity.",
  emptyHint = "Repositories pushed to this workspace will appear here.",
  headerExtra,
  onOpenItem,
}: {
  repos: ProjectRepo[];
  items: ProjectWorkItem[];
  isLoading: boolean;
  intro?: string;
  emptyHint?: string;
  headerExtra?: React.ReactNode;
  onOpenItem?: (item: ProjectWorkItem) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sort, setSort] = useState<ProjectSort>("updated");
  const [statusFilter, setStatusFilter] = useState<"open" | "closed" | "all">("open");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);

  const items = workItems;
  const summaries = useMemo(() => repoSummaries(items), [items]);
  const people = useMemo(() => projectPeople(repos, items), [repos, items]);
  const repoNameByCoord = useMemo(() => new Map(repos.map((r) => [r.coord, r.name])), [repos]);

  const sortedRepos = useMemo(() => {
    const list = [...repos];
    return sort === "name"
      ? list.sort((a, b) => a.name.localeCompare(b.name))
      : list.sort((a, b) => b.createdAt - a.createdAt);
  }, [repos, sort]);

  const prs = useMemo(() => items.filter((i) => i.kind !== "issue"), [items]);
  const issues = useMemo(() => items.filter((i) => i.kind === "issue"), [items]);
  // Drafts count as open (they are unresolved work), matching the trackers
  // people come from.
  const matchesFilters = useCallback((item: ProjectWorkItem) => {
    const unresolved = item.status === "open" || item.status === "draft";
    if (statusFilter === "open" && !unresolved) return false;
    if (statusFilter === "closed" && unresolved) return false;
    if (labelFilter && !(item.labels ?? []).includes(labelFilter)) return false;
    return true;
  }, [statusFilter, labelFilter]);
  const filteredPrs = useMemo(() => sortProjectWorkItems(prs.filter(matchesFilters), sort), [prs, matchesFilters, sort]);
  const filteredIssues = useMemo(() => sortProjectWorkItems(issues.filter(matchesFilters), sort), [issues, matchesFilters, sort]);
  const toggleLabel = useCallback((label: string) => setLabelFilter((current) => (current === label ? null : label)), []);
  const showAll = useCallback(() => {
    setStatusFilter("all");
    setLabelFilter(null);
  }, []);
  const summaryOf = (coord: string): ProjectRepoSummary => summaries.get(coord) ?? { prCount: 0, issueCount: 0 };
  const peopleOf = (repo: ProjectRepo): string[] => [...new Set([repo.owner, ...repo.contributors])];

  const loading = isLoading;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{intro}</p>
        {headerExtra}
      </div>

      {/* Tabs + controls. Wrapping is measured from each item's content width,
          so the controls drop to their own line the moment the tabs stop
          fitting beside them — rather than squeezing the tabs, which no
          viewport breakpoint could detect inside a narrow pane. */}
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <Tabs filter={filter} onChange={setFilter} />
        {filter !== "all" && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {(filter === "prs" || filter === "issues") && labelFilter && (
              <Button variant="secondary" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setLabelFilter(null)}>
                {labelFilter}
                <X className="size-3" />
              </Button>
            )}
            {(filter === "prs" || filter === "issues") && (
              <div className="flex items-center rounded-lg bg-muted/40 p-0.5">
                {(["open", "closed", "all"] as const).map((value) => (
                  <Button
                    key={value}
                    variant={statusFilter === value ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 px-2 text-xs capitalize"
                    aria-pressed={statusFilter === value}
                    onClick={() => setStatusFilter(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            )}
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as ProjectSort)}
              aria-label="Sort"
              className="h-8 clip-corner-lg bg-transparent px-2 text-xs text-foreground outline-none hover:bg-foreground/5 focus:ring-1 focus:ring-ring"
            >
              <option value="updated">Recent</option>
              <option value="name">Name</option>
            </select>
            {/* Repositories are the only list with two layouts; work items
                always read as rows, so the toggle would be inert there. */}
            {filter === "repositories" && (
              <div className="flex items-center rounded-lg bg-muted/40 p-0.5">
                <Button
                  variant={viewMode === "grid" ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7"
                  aria-label="Grid layout"
                  aria-pressed={viewMode === "grid"}
                  onClick={() => setViewMode("grid")}
                >
                  <LayoutGrid className="size-3.5" />
                </Button>
                <Button
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7"
                  aria-label="List layout"
                  aria-pressed={viewMode === "list"}
                  onClick={() => setViewMode("list")}
                >
                  <List className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="pt-6">
        {loading ? (
          <CardsSkeleton />
        ) : repos.length === 0 ? (
          <EmptyState icon={FolderGit2} title="No projects yet" hint={emptyHint} />
        ) : filter === "all" ? (
          <Overview repos={repos} items={items} people={people} onSelect={setFilter} onOpenItem={onOpenItem} />
        ) : filter === "repositories" ? (
          viewMode === "grid" ? (
            <div className={CARD_GRID}>
              {sortedRepos.map((repo) => (
                <RepoCard key={repo.coord} repo={repo} summary={summaryOf(repo.coord)} people={peopleOf(repo)} />
              ))}
            </div>
          ) : (
            <div className="clip-corner-lg border border-border/60 bg-card divide-y divide-border/60">
              {sortedRepos.map((repo) => (
                <RepoRow key={repo.coord} repo={repo} summary={summaryOf(repo.coord)} people={peopleOf(repo)} />
              ))}
            </div>
          )
        ) : filter === "prs" ? (
          filteredPrs.length > 0 ? (
            <div className="clip-corner-lg border border-border/60 bg-card divide-y divide-border/60">
              {filteredPrs.map((item) => (
                <WorkItemRow
                  key={item.id}
                  item={item}
                  repoName={item.repoCoord ? repoNameByCoord.get(item.repoCoord) : undefined}
                  onOpen={onOpenItem && (() => onOpenItem(item))}
                  onLabelClick={toggleLabel}
                />
              ))}
            </div>
          ) : prs.length > 0 ? (
            <FilteredOutNotice onShowAll={showAll} />
          ) : (
            <EmptyState icon={GitPullRequest} title="No pull requests" hint="Patches and PRs opened on this workspace will appear here." />
          )
        ) : filteredIssues.length > 0 ? (
          <div className="clip-corner-lg border border-border/60 bg-card divide-y divide-border/60">
            {filteredIssues.map((item) => (
              <WorkItemRow
                key={item.id}
                item={item}
                repoName={item.repoCoord ? repoNameByCoord.get(item.repoCoord) : undefined}
                onOpen={onOpenItem && (() => onOpenItem(item))}
                onLabelClick={toggleLabel}
              />
            ))}
          </div>
        ) : issues.length > 0 ? (
          <FilteredOutNotice onShowAll={showAll} />
        ) : (
          <EmptyState icon={CircleDot} title="No issues" hint="Issues opened on this workspace will appear here." />
        )}
      </div>
    </div>
  );
}

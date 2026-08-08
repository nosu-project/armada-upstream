import { ArrowUpRight, Braces, CheckCircle2, ChevronDown, ChevronRight, CircleDot, CircleSlash, Clock, ExternalLink, GitPullRequest, Loader2, MessageCircle, Paperclip, Pencil, ScrollText, Trash2, X, XCircle } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";


import type { GitChannelTimelineEntry } from "@/components/chat/channelTimeline";
import { isCommunityGuest } from "@/components/chat/channelTimeline";
import { ChatContent } from "@/components/chat/ChatContent";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useAuthor } from "@/hooks/useAuthor";
import { useGitAttachmentUploads } from "@/hooks/useGitAttachmentUploads";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { ciGroupsOutcome, ciGroupsSummary, ciRunOutcome, ciWorkflowName, groupCIRunsByWorkflow, type CIRun, type CIRunJob, type CIWorkflowGroup } from "@/lib/ci";
import { shortTimeAgo } from "@/lib/formatTime";
import { gitAttachmentLabel, gitBodyPreview } from "@/lib/gitSummary";
import {
  GIT_ISSUE_KIND,
  GIT_STATUS_APPLIED_KIND,
  GIT_STATUS_CLOSED_KIND,
  GIT_STATUS_DRAFT_KIND,
  GIT_STATUS_OPEN_KIND,
  gitStatusFromKind,
  type GitComment,
  type GitStatusKind,
  type GitTicket,
  type GitTicketStatus,
  type GitTimelineActivity,
} from "@/lib/gitActivity";
import { cn } from "@/lib/utils";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ReactNode } from "react";

/** Callbacks that make the conversation panel writable. All optional: absent means read-only. */
export interface TicketPanelActions {
  /** The signed-in viewer; own comments get edit/delete controls. */
  viewerPubkey?: string;
  /** Post a top-level comment on the ticket; `media` carries NIP-92 imeta tags for attached uploads. */
  onComment?: (ticket: GitTicket, content: string, media?: readonly string[][]) => Promise<unknown>;
  /** Replace one of the viewer's own comments (new event + NIP-09 retraction of the old). */
  onEditComment?: (ticket: GitTicket, comment: GitComment, content: string) => Promise<unknown>;
  /** Retract one of the viewer's own comments (NIP-09). */
  onDeleteComment?: (ticket: GitTicket, comment: GitComment) => Promise<unknown>;
  /** Publish a status change; only offered when `canSetStatus`. */
  onSetStatus?: (ticket: GitTicket, statusKind: GitStatusKind) => Promise<unknown>;
  /** Whether the viewer is in the ticket's trusted status-author set. */
  canSetStatus?: boolean;
}

function TicketIcon({ ticket, className }: { ticket: GitTicket; className?: string }) {
  const Icon = ticket.type === "issue" ? CircleDot : GitPullRequest;
  return <Icon className={cn("size-3.5 shrink-0", ticket.type === "issue" ? "text-emerald-500" : "text-violet-500", className)} />;
}

function ticketType(ticket: GitTicket) {
  return ticket.type === "issue" ? "Issue" : "Pull request";
}

/**
 * The gutter a chat row spends on its avatar (`size-10` plus a `gap-3`). Git
 * rows reuse it so their text sits on the SAME column as every message around
 * them: a second text column is what made this activity read as a separate,
 * louder feed pasted into the conversation.
 */
const GUTTER = "flex w-[3.25rem] shrink-0 justify-end pr-3 pt-0.5";

/**
 * The quietest row the timeline has: an icon in the gutter and one muted line
 * where a message's text would be. No border, no fill, no card — a fact about
 * the repository stated at the volume of a fact, not of a message.
 */
function NoticeRow({ icon, onClick, label, children, detail }: { icon: ReactNode; onClick?: () => void; label?: string; children: ReactNode; detail?: ReactNode }) {
  return (
    <div data-git-entry className="px-2.5">
      <div className={cn("flex items-start rounded py-1 transition-colors", onClick && "hover:bg-secondary/40")}>
        <span className={GUTTER}>{icon}</span>
        <div className="min-w-0 flex-1 pr-2">
          {onClick
            ? <button type="button" onClick={onClick} aria-label={label} className="block w-full text-left text-xs leading-5 text-muted-foreground">{children}</button>
            : <p className="text-xs leading-5 text-muted-foreground">{children}</p>}
          {detail}
        </div>
      </div>
    </div>
  );
}

/** A Git event rendered as a contextual channel reference. The underlying NIP-34/NIP-22 event remains the source of truth. */
export function GitTimelineRow({ entry, related, members, onOpen, activities = [] }: { entry: GitChannelTimelineEntry; members: ReadonlySet<string>; onOpen: (ticket: GitTicket) => void; related?: readonly GitChannelTimelineEntry[]; activities?: readonly GitTimelineActivity[] }) {
  // A dispatcher, deliberately hook-free: the four shapes share no state, and
  // branching inside one component would reorder its hooks.
  if (entry.type === "git-ci-run") {
    return <CIGroupRow entries={sameType(entry, related)} members={members} />;
  }
  if (entry.type === "git-status") {
    return <StatusGroupRow entries={sameType(entry, related)} members={members} onOpen={onOpen} />;
  }
  if (entry.type === "git-comment") {
    return <CommentGroupRow entries={sameType(entry, related)} members={members} onOpen={onOpen} activities={activities} />;
  }
  return <TicketOpenedRow entry={entry} members={members} onOpen={onOpen} />;
}

/**
 * The group a row renders, narrowed to the head's own variant. The timeline
 * only ever groups like with like ({@link isGitContinuation}), so this is a
 * cast the grouping rule already guarantees — but it is checked rather than
 * asserted, because a future rule that groups two variants must not silently
 * hand a row entries it will read the wrong fields off.
 */
function sameType<T extends GitChannelTimelineEntry["type"]>(
  head: Extract<GitChannelTimelineEntry, { type: T }>,
  related: readonly GitChannelTimelineEntry[] | undefined,
): readonly Extract<GitChannelTimelineEntry, { type: T }>[] {
  if (!related || related.length === 0) return [head];
  return related.filter((entry): entry is Extract<GitChannelTimelineEntry, { type: T }> => entry.type === head.type);
}

/**
 * A body reduced to prose plus a count of what was dropped. The full body —
 * markdown, screenshots, screen recordings — is one click away in the panel,
 * which is the only place it can be read without taking the channel over.
 */
function BodyPreview({ content, onOpen, className }: { content: string; onOpen: () => void; className?: string }) {
  const preview = useMemo(() => gitBodyPreview(content), [content]);
  const attachments = gitAttachmentLabel(preview);
  if (!preview.text && !attachments) return null;
  return (
    <button type="button" onClick={onOpen} className={cn("block w-full text-left", className)}>
      {preview.text && (
        <span className="line-clamp-2 text-sm leading-5 text-muted-foreground">
          {preview.text}
          {preview.truncated && <span className="ml-1 text-primary">more</span>}
        </span>
      )}
      {attachments && (
        <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground/80">
          <Paperclip className="size-3 shrink-0" />
          {attachments}
        </span>
      )}
    </button>
  );
}

/** A ticket named inline, at the size of a caption: the row's subject line. */
function TicketReference({ ticket, repository, onOpen, suffix }: { ticket: GitTicket; repository?: string; onOpen: () => void; suffix?: ReactNode }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
      <TicketIcon ticket={ticket} className="size-3" />
      <span className="min-w-0 truncate font-medium text-foreground/90">{ticket.subject}</span>
      {repository && <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{repository}</span>}
      {suffix}
    </button>
  );
}

function TicketOpenedRow({ entry, members, onOpen }: { entry: Extract<GitChannelTimelineEntry, { type: "git-ticket-opened" }>; members: ReadonlySet<string>; onOpen: (ticket: GitTicket) => void }) {
  const { ticket, repository } = entry.activity;
  const open = () => onOpen(ticket);
  const action = ticket.type === "issue" ? "opened an issue" : "opened a pull request";
  return (
    <article data-git-entry className="px-2.5">
      <div className="flex items-start gap-3 rounded py-1.5 transition-colors hover:bg-secondary/40">
        <Avatar className="size-10 shrink-0"><ActorAvatar pubkey={ticket.author} /></Avatar>
        <div className="min-w-0 flex-1 pr-2">
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            <ActorName pubkey={ticket.author} members={members} className="text-[15px]" />
            <span className="text-xs text-muted-foreground">{action} in {repository.identifier} · {shortTimeAgo(entry.createdAt)}</span>
          </p>
          <TicketReference ticket={ticket} onOpen={open} />
          <BodyPreview content={ticket.content} onOpen={open} className="mt-0.5" />
        </div>
      </div>
    </article>
  );
}

function CommentGroupRow({ entries, members, onOpen, activities }: { entries: readonly Extract<GitChannelTimelineEntry, { type: "git-comment" }>[]; members: ReadonlySet<string>; onOpen: (ticket: GitTicket) => void; activities: readonly GitTimelineActivity[] }) {
  const { ticket, repository } = entries[0].activity;
  const open = () => onOpen(ticket);
  // How much of the ticket's discussion this block is NOT showing. One number
  // rather than the old pair of "earlier"/"later" arrows: the row's job is to
  // say that the conversation continues elsewhere, not to navigate it.
  const total = useMemo(
    () => activities.filter((activity) => activity.type === "comment" && activity.ticket.id === ticket.id).length,
    [activities, ticket.id],
  );
  const hidden = Math.max(0, total - entries.length);

  return (
    <article data-git-entry className="px-2.5">
      <div className="rounded py-1 transition-colors hover:bg-secondary/40">
        <div className="flex items-start">
          <span className={GUTTER}><MessageCircle className="size-3.5 text-muted-foreground/70" /></span>
          <div className="min-w-0 flex-1 pr-2"><TicketReference ticket={ticket} repository={repository.identifier} onOpen={open} /></div>
        </div>
        <div className="mt-0.5 space-y-1">
          {entries.map((entry) => <GitCommentRow key={entry.id} entry={entry} members={members} onOpen={open} />)}
        </div>
        {hidden > 0 && (
          <div className="flex items-start">
            <span className={GUTTER} />
            <button type="button" onClick={open} className="text-xs text-muted-foreground hover:text-foreground">
              View all {total} comments
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function GitCommentRow({ entry, members, onOpen }: { entry: Extract<GitChannelTimelineEntry, { type: "git-comment" }>; members: ReadonlySet<string>; onOpen: () => void }) {
  const { comment } = entry.activity;
  return (
    <div className="flex items-start gap-3">
      <Avatar className="size-10 shrink-0"><ActorAvatar pubkey={comment.author} /></Avatar>
      <div className="min-w-0 flex-1 pr-2">
        <p className="flex flex-wrap items-baseline gap-x-1.5">
          <ActorName pubkey={comment.author} members={members} className="text-[15px]" />
          <span className="text-xs text-muted-foreground">{shortTimeAgo(entry.createdAt)}</span>
        </p>
        <BodyPreview content={comment.content} onOpen={onOpen} />
      </div>
    </div>
  );
}

/** Past tense for the state a ticket ended up in. */
function statusVerb(status: GitTicketStatus): string {
  switch (status) {
    case "closed": return "closed";
    case "merged": return "merged";
    case "resolved": return "resolved";
    case "draft": return "marked as draft";
    default: return "reopened";
  }
}

/**
 * A stretch of status changes on one ticket, shown as its OUTCOME. A ticket
 * closed, reopened and closed again is one fact — it is closed — and the three
 * events that got there are the panel's business.
 */
function StatusGroupRow({ entries, members, onOpen }: { entries: readonly Extract<GitChannelTimelineEntry, { type: "git-status" }>[]; members: ReadonlySet<string>; onOpen: (ticket: GitTicket) => void }) {
  const last = entries[entries.length - 1];
  const { ticket, status } = last.activity;
  const resolved = gitStatusFromKind(status.kind, ticket.kind);
  return (
    <NoticeRow
      icon={<TicketIcon ticket={ticket} />}
      onClick={() => onOpen(ticket)}
      label={`Open ${ticket.subject}`}
    >
      <ActorName pubkey={status.author} members={members} className="text-xs" /> {statusVerb(resolved)}{" "}
      <span className="text-foreground/90">{ticket.subject}</span>
      {entries.length > 1 && <span className="text-muted-foreground/70"> · {entries.length} status changes</span>}
      <span className="text-muted-foreground/70"> · {shortTimeAgo(last.createdAt)}</span>
    </NoticeRow>
  );
}

function ActorAvatar({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <><AvatarImage src={author.data?.metadata?.picture} alt={name} /><AvatarFallback className="text-[10px] font-semibold">{name.slice(0, 1)}</AvatarFallback></>;
}

/** Icon + tone + phrasing for a run's outcome. Unknown values read as neutral. */
function ciOutcomePresentation(outcome: string): { Icon: typeof CheckCircle2; tone: string; label: string } {
  switch (outcome) {
    case "success": return { Icon: CheckCircle2, tone: "text-emerald-500", label: "succeeded" };
    case "failure": return { Icon: XCircle, tone: "text-destructive", label: "failed" };
    case "timed_out": return { Icon: Clock, tone: "text-destructive", label: "timed out" };
    case "startup_failure": return { Icon: XCircle, tone: "text-destructive", label: "failed to start" };
    case "cancelled": return { Icon: CircleSlash, tone: "text-muted-foreground", label: "was cancelled" };
    case "skipped": return { Icon: CircleSlash, tone: "text-muted-foreground", label: "was skipped" };
    case "queued": return { Icon: Clock, tone: "text-muted-foreground", label: "is queued" };
    case "in_progress": return { Icon: Loader2, tone: "text-muted-foreground", label: "is running" };
    default: return { Icon: CircleDot, tone: "text-muted-foreground", label: "finished" };
  }
}

/**
 * A CI workflow run. The signer is always shown: the CI extension leaves
 * publisher trust to the client and nothing on-relay binds a coordinator to a
 * repository, so this row reports a claim rather than a verified fact.
 */
/** Never render an unbounded log body into the timeline. */
const CI_LOG_MAX_BYTES = 512 * 1024;

/**
 * One job's log, fetched on demand from Blossom and rendered inline.
 *
 * The fetch is deferred to first expand: a channel can hold many runs and each
 * log is an arbitrary-size blob on a third-party host. The Job Result's own
 * `content` tail renders immediately as a preview, so an unreachable Blossom
 * server still leaves something readable rather than an empty block.
 */
function CIJobLog({ job }: { job: CIRunJob }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const url = job.result?.logs;
  const tail = job.result?.event.content?.trim() || undefined;

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || text !== undefined || loading || !url) return;
    if (!/^https:\/\//i.test(url)) {
      setError("Log URL is not https.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status}`);
      const body = await response.text();
      setText(body.length > CI_LOG_MAX_BYTES ? `${body.slice(0, CI_LOG_MAX_BYTES)}\n…truncated` : body);
    } catch (e) {
      setError(e instanceof Error ? `Couldn't load the log (${e.message}).` : "Couldn't load the log.");
    } finally {
      setLoading(false);
    }
  }, [open, text, loading, url]);

  const body = text ?? (error ? tail : undefined);
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2">
        <button type="button" onClick={toggle} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <ScrollText className="size-3" />
          <span>{job.result?.name || job.job}</span>
          {loading && <Loader2 className="size-3 animate-spin" />}
        </button>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Open the full log"
            aria-label="Open the full log"
            className="text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      {open && (
        <>
          {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
          {body ? (
            <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-relaxed">
              <code className="font-mono whitespace-pre">{body}</code>
            </pre>
          ) : (
            !loading && !error && <p className="mt-1 text-[11px] text-muted-foreground">No log output.</p>
          )}
        </>
      )}
    </div>
  );
}

/** The run's outcome as prose. The signer is part of the sentence, not a footnote. */
function CIRunSentence({ run, members, workflow = true }: { run: CIRun; members: ReadonlySet<string>; workflow?: boolean }) {
  const { label } = ciOutcomePresentation(ciRunOutcome(run));
  return (
    <>
      {workflow && <span className="font-medium text-foreground/90">{ciWorkflowName(run)}</span>}
      <span>{workflow ? " " : ""}{label}</span>
      {run.commit && <span> on <span className="font-mono">{run.commit.slice(0, 7)}</span></span>}
      {run.trigger && <span> · {run.trigger}</span>}
      <span> · {shortTimeAgo(run.createdAt)}</span>
      <span> · reported by </span>
      <ActorName pubkey={run.author} members={members} className="text-xs" />
    </>
  );
}

/** One run's icon, in the tone its outcome earns. */
function CIOutcomeIcon({ outcome, className }: { outcome: string; className?: string }) {
  const { Icon, tone } = ciOutcomePresentation(outcome);
  return <Icon className={cn("size-3.5 shrink-0", tone, outcome === "in_progress" && "animate-spin", className)} />;
}

/** The jobs of a run that have anything to show. */
function loggedJobs(run: CIRun): CIRunJob[] {
  return run.jobs.filter((job) => job.result?.logs || job.result?.event.content?.trim());
}

function CIRunLine({ run, members }: { run: CIRun; members: ReadonlySet<string> }) {
  const logged = loggedJobs(run);
  return (
    <NoticeRow
      icon={<CIOutcomeIcon outcome={ciRunOutcome(run)} />}
      detail={logged.length > 0 ? <div>{logged.map((job) => <CIJobLog key={job.eventId} job={job} />)}</div> : undefined}
    >
      <CIRunSentence run={run} members={members} />
    </NoticeRow>
  );
}

/** Outcomes of the runs a workflow's current state replaced, as a strip of dots. */
function CIHistoryStrip({ runs }: { runs: readonly CIRun[] }) {
  const shown = runs.slice(0, 12);
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground/70">
      <span>before that</span>
      {shown.map((run) => {
        const outcome = ciRunOutcome(run);
        return (
          <span key={run.id} title={[run.commit?.slice(0, 7), ciOutcomePresentation(outcome).label, shortTimeAgo(run.createdAt)].filter(Boolean).join(" · ")}>
            <CIOutcomeIcon outcome={outcome} className="size-3" />
          </span>
        );
      })}
      {runs.length > shown.length && <span>+{runs.length - shown.length}</span>}
    </p>
  );
}

/** One workflow inside an expanded stretch: its current state, then its history. */
function CIWorkflowDetail({ group, members }: { group: CIWorkflowGroup; members: ReadonlySet<string> }) {
  const logged = loggedJobs(group.latest);
  return (
    <div className="min-w-0">
      <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
        <CIOutcomeIcon outcome={ciRunOutcome(group.latest)} className="mt-1" />
        <span className="min-w-0"><CIRunSentence run={group.latest} members={members} /></span>
      </p>
      {group.runs.length > 1 && <CIHistoryStrip runs={group.runs.slice(1)} />}
      {logged.map((job) => <CIJobLog key={job.eventId} job={job} />)}
    </div>
  );
}

/**
 * A stretch of CI activity, folded to the state each workflow is in NOW.
 *
 * Twenty rows of the same job passing and failing tell a reader one thing —
 * where it stands — and cost them the conversation to find it out. So the
 * stretch states that, and the runs behind it open on click.
 */
function CIGroupRow({ entries, members }: { entries: readonly Extract<GitChannelTimelineEntry, { type: "git-ci-run" }>[]; members: ReadonlySet<string> }) {
  const [open, setOpen] = useState(false);
  const runs = useMemo(() => entries.map((entry) => entry.activity.run), [entries]);
  const groups = useMemo(() => groupCIRunsByWorkflow(runs), [runs]);

  // A lone run has nothing to fold: it reads as the sentence it already is.
  if (runs.length === 1) return <CIRunLine run={runs[0]} members={members} />;

  const only = groups.length === 1 ? groups[0] : undefined;
  const newest = groups[0].latest;
  return (
    <NoticeRow
      icon={<CIOutcomeIcon outcome={ciGroupsOutcome(groups)} />}
      onClick={() => setOpen((previous) => !previous)}
      label={open ? "Hide CI runs" : "Show CI runs"}
      detail={open ? <div className="mt-1 space-y-2 border-l border-border pl-2.5">{groups.map((group) => <CIWorkflowDetail key={group.name} group={group} members={members} />)}</div> : undefined}
    >
      {only
        ? <>
            <span className="font-medium text-foreground/90">{only.name}</span>
            <span> {ciOutcomePresentation(ciRunOutcome(only.latest)).label}</span>
            <span> · latest of {only.runs.length} runs</span>
          </>
        : <>
            <span className="font-medium text-foreground/90">CI</span>
            <span> · {runs.length} runs across {groups.length} workflows</span>
            <span> · {ciGroupsSummary(groups)}</span>
          </>}
      <span> · {shortTimeAgo(newest.createdAt)}</span>
      {open ? <ChevronDown className="ml-1 inline size-3 align-[-1px]" /> : <ChevronRight className="ml-1 inline size-3 align-[-1px]" />}
    </NoticeRow>
  );
}

function ActorName({ pubkey, members, className }: { pubkey: string; members: ReadonlySet<string>; className?: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <><span className={cn("font-semibold text-foreground", className ?? "text-sm")}>{name}</span>{isCommunityGuest(pubkey, members) && <span className="ml-1 rounded border border-border px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Guest</span>}</>;
}

function statusOptions(status: GitTicketStatus, ticket: GitTicket): Array<{ label: string; kind: GitStatusKind }> {
  if (status === "closed" || status === "merged" || status === "resolved") {
    return [{ label: "Reopen", kind: GIT_STATUS_OPEN_KIND }];
  }
  const options: Array<{ label: string; kind: GitStatusKind }> = [];
  if (status === "draft") options.push({ label: "Mark open", kind: GIT_STATUS_OPEN_KIND });
  options.push({ label: ticket.kind === GIT_ISSUE_KIND ? "Mark resolved" : "Mark merged", kind: GIT_STATUS_APPLIED_KIND });
  if (status === "open" && ticket.kind !== GIT_ISSUE_KIND) options.push({ label: "Mark draft", kind: GIT_STATUS_DRAFT_KIND });
  options.push({ label: "Close", kind: GIT_STATUS_CLOSED_KIND });
  return options;
}

function TicketStatusControls({ ticket, status, onSet }: { ticket: GitTicket; status: GitTicketStatus; onSet: NonNullable<TicketPanelActions["onSetStatus"]> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {statusOptions(status, ticket).map(({ label, kind }) => (
        <Button
          key={label}
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onSet(ticket, kind)
              .catch((error) => toast({ title: "Couldn't update status", description: error instanceof Error ? error.message : undefined, variant: "destructive" }))
              .finally(() => setBusy(false));
          }}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function TicketCommentComposer({ ticket, onComment }: { ticket: GitTicket; onComment: NonNullable<TicketPanelActions["onComment"]> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const appendUrl = useCallback((url: string) => {
    setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${url}\n` : `${url}\n`));
  }, []);
  const { attach, isUploading, mediaFor } = useGitAttachmentUploads(appendUrl);
  const submit = () => {
    const content = text.trim();
    if (!content || sending || isUploading) return;
    setSending(true);
    onComment(ticket, content, mediaFor(content))
      .then(() => setText(""))
      .catch((error) => toast({ title: "Couldn't post comment", description: error instanceof Error ? error.message : undefined, variant: "destructive" }))
      .finally(() => setSending(false));
  };

  // Grow the textarea with its content, capped, like the shared ChatComposer.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const placeholder = `Comment on this ${ticket.type === "issue" ? "issue" : "pull request"}`;

  return (
    <div className="shrink-0 p-2 pb-safe">
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void attach(e.target.files);
          e.target.value = "";
        }}
      />
      {/* Shared composer pill: recessed rounded field, self-growing borderless
          textarea, primary send action. Mirrors ChatComposer. */}
      <div className="flex items-end gap-0.5 touch:gap-1.5 clip-corner-lg bg-secondary/60 px-1.5 py-1.5">
        <button
          type="button"
          aria-label="Attach files"
          disabled={isUploading}
          onClick={() => fileInput.current?.click()}
          className="p-2 shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40 flex items-center justify-center size-9 touch:size-11"
        >
          {isUploading ? <Loader2 className="size-5 animate-spin" /> : <Paperclip className="size-5" />}
        </button>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Ignore the Enter that only
            // confirms an in-progress IME composition (CJK and other
            // multi-keystroke input), which would otherwise fire a premature send.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={1}
          className="block flex-1 min-w-0 resize-none bg-transparent border-0 outline-none px-1.5 py-2 touch:py-3 leading-5 text-base md:text-sm max-h-40 overflow-y-auto align-middle placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={submit}
          disabled={sending || isUploading || !text.trim()}
          aria-label="Comment"
          className="p-2 shrink-0 clip-corner-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:bg-transparent disabled:text-muted-foreground flex items-center justify-center size-9 touch:size-11"
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUpRight className="size-5" strokeWidth={2.5} />}
        </button>
      </div>
      <p className="mt-1 px-1.5 truncate text-[10px] text-muted-foreground">Public: repository discussion is visible outside this community.</p>
    </div>
  );
}

/** The ticket's public home on gitworkshop.dev, the reference NIP-34 web client. */
function gitworkshopUrl(ticket: GitTicket): string | undefined {
  const address = ticket.repositoryAddress;
  if (!address) return undefined;
  try {
    const npub = nip19.npubEncode(address.owner);
    const nevent = nip19.neventEncode({ id: ticket.id, author: ticket.author, kind: ticket.kind });
    return `https://gitworkshop.dev/${npub}/${encodeURIComponent(address.identifier)}/${ticket.type === "issue" ? "issues" : "prs"}/${nevent}`;
  } catch {
    return undefined;
  }
}

function TicketPanelBody({ ticket, members, activities, actions }: { ticket: GitTicket; members: ReadonlySet<string>; activities: readonly GitTimelineActivity[]; actions?: TicketPanelActions }) {
  const [jsonOpen, setJsonOpen] = useState(false);
  const workshopUrl = useMemo(() => gitworkshopUrl(ticket), [ticket]);
  const { comments, latestStatus } = useMemo(() => {
    const related = activities.filter(
      (activity): activity is Exclude<GitTimelineActivity, { type: "ci-run" }> =>
        activity.type !== "ci-run" && activity.ticket.id === ticket.id,
    );
    return {
      comments: related.filter((activity): activity is Extract<GitTimelineActivity, { type: "comment" }> => activity.type === "comment").sort((a, b) => a.createdAt - b.createdAt || a.comment.id.localeCompare(b.comment.id)),
      latestStatus: related.filter((activity): activity is Extract<GitTimelineActivity, { type: "status-change" }> => activity.type === "status-change").sort((a, b) => b.createdAt - a.createdAt || a.status.event.id.localeCompare(b.status.event.id))[0],
    };
  }, [activities, ticket.id]);
  const status = gitStatusFromKind(latestStatus?.status.kind, ticket.kind);
  const repository = ticket.repositoryAddress?.identifier ?? "Unknown repository";

  return <div className="flex min-h-0 flex-1 flex-col"><div className="min-h-0 flex-1 overflow-y-auto p-3"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><TicketIcon ticket={ticket} />{ticketType(ticket)}</div><h2 className="mt-2 break-words text-sm font-semibold">{ticket.subject}</h2><p className="mt-1 text-xs text-muted-foreground">{repository} · <span className="capitalize">{status}</span></p>{actions?.canSetStatus && actions.onSetStatus && <TicketStatusControls ticket={ticket} status={status} onSet={actions.onSetStatus} />}<div className="my-4 border-t border-border" /><p className="text-xs text-muted-foreground">This is the work item’s durable discussion. Its card in the channel is a contextual reference, not a chat thread.</p>{ticket.content && <DiscussionMessage pubkey={ticket.author} createdAt={ticket.createdAt} event={ticket.event} members={members} className="mt-4" />}<div className="mt-4 space-y-4">{comments.map(({ comment }) => <DiscussionMessage key={comment.id} pubkey={comment.author} createdAt={comment.createdAt} event={comment.event} members={members} controls={actions?.viewerPubkey === comment.author && actions.onEditComment && actions.onDeleteComment ? { text: comment.content, onEdit: (content) => actions.onEditComment!(ticket, comment, content), onDelete: () => actions.onDeleteComment!(ticket, comment) } : undefined} />)}</div>{comments.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No comments yet.</p>}<div className="mt-4 flex flex-wrap gap-1.5">{workshopUrl && <Button variant="ghost" size="sm" asChild><a href={workshopUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-2 size-4" />Open on gitworkshop</a></Button>}<Button variant="ghost" size="sm" onClick={() => setJsonOpen(true)}><Braces className="mr-2 size-4" />View event JSON</Button></div></div>{actions?.onComment && <TicketCommentComposer ticket={ticket} onComment={actions.onComment} />}<Dialog open={jsonOpen} onOpenChange={setJsonOpen}><DialogContent><DialogHeader><DialogTitle>Event JSON</DialogTitle></DialogHeader><pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(ticket.event, null, 2)}</pre></DialogContent></Dialog></div>;
}

/** Own-comment controls: inline edit and confirmed delete. */
interface DiscussionControls {
  text: string;
  onEdit: (content: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}

function DiscussionMessage({ pubkey, createdAt, event, members, className, controls }: { pubkey: string; createdAt: number; event: NostrRumor; members: ReadonlySet<string>; className?: string; controls?: DiscussionControls }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const saveEdit = () => {
    const content = draft.trim();
    if (!controls || !content || busy) return;
    if (content === controls.text.trim()) {
      setEditing(false);
      return;
    }
    setBusy(true);
    controls.onEdit(content)
      .then(() => setEditing(false))
      .catch((error) => toast({ title: "Couldn't edit comment", description: error instanceof Error ? error.message : undefined, variant: "destructive" }))
      .finally(() => setBusy(false));
  };
  const runDelete = () => {
    if (!controls || busy) return;
    setBusy(true);
    controls.onDelete()
      .catch((error) => toast({ title: "Couldn't delete comment", description: error instanceof Error ? error.message : undefined, variant: "destructive" }))
      .finally(() => setBusy(false));
  };

  return (
    <div className={cn("group relative flex gap-2.5", className)}>
      <Avatar className="size-8 shrink-0"><ActorAvatar pubkey={pubkey} /></Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><ActorName pubkey={pubkey} members={members} /><span className="text-xs text-muted-foreground">commented · {shortTimeAgo(createdAt)}</span></div>
        {editing && controls ? (
          <div className="mt-1">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  saveEdit();
                }
              }}
              rows={3}
              autoFocus
              className="min-h-0 resize-none text-sm"
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" className="h-7 px-2.5 text-xs" disabled={busy || !draft.trim()} onClick={saveEdit}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <ChatContent event={event} disableNoteEmbeds documentMarkdown className="mt-1 break-words text-sm leading-5" />
        )}
      </div>
      {controls && !editing && (
        <div className="absolute -top-1 right-0 flex gap-0.5 rounded-md border border-border bg-card p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            aria-label="Edit comment"
            disabled={busy}
            onClick={() => {
              setDraft(controls.text);
              setEditing(true);
            }}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-destructive"
            aria-label="Delete comment"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          </Button>
        </div>
      )}
      {controls && (
        <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this comment?</AlertDialogTitle>
              <AlertDialogDescription>
                This publishes a deletion request. Most clients will hide the comment, but relays and clients that ignore deletion requests may keep showing it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={runDelete}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

export function TicketSidePanel({ ticket, members, activities, onClose, actions }: { ticket: GitTicket | undefined; members: ReadonlySet<string>; activities: readonly GitTimelineActivity[]; onClose: () => void; actions?: TicketPanelActions }) {
  const isDesktop = useIsDesktop();

  return (
    <>
      <aside className={cn(
        "hidden shrink-0 overflow-hidden sidebar:flex sidebar:flex-col sidebar:transition-[width] sidebar:duration-200",
        ticket ? "sidebar:w-[22rem]" : "sidebar:w-0",
      )}>
        {ticket && (
          <div className="flex flex-1 min-h-0 flex-col m-2 sidebar:my-3 sidebar:mr-2 sidebar:ml-0 p-1.5 clip-corner-lg bg-chrome">
            <div className="flex items-center justify-between px-2 py-1 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <MessageCircle className="size-4 text-muted-foreground shrink-0" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
                  Conversation
                </h3>
              </div>
              <Button variant="ghost" size="icon" className="size-6 touch:size-10" onClick={onClose} aria-label="Close conversation">
                <X className="size-4" />
              </Button>
            </div>
            <TicketPanelBody ticket={ticket} members={members} activities={activities} actions={actions} />
          </div>
        )}
      </aside>
      {ticket && !isDesktop && (
        <Sheet open onOpenChange={(open) => !open && onClose()}>
          <SheetContent side="right" className="flex w-[92vw] max-w-none flex-col p-0">
            <div className="flex items-center gap-2 px-3 py-2 shrink-0">
              <MessageCircle className="size-4 text-muted-foreground shrink-0" />
              <SheetTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Conversation
              </SheetTitle>
            </div>
            <TicketPanelBody ticket={ticket} members={members} activities={activities} actions={actions} />
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

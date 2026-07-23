import { Braces, CircleDot, GitPullRequest, MessageCircle, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { GitChannelTimelineEntry } from "@/components/chat/channelTimeline";
import { isCommunityGuest } from "@/components/chat/channelTimeline";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAuthor } from "@/hooks/useAuthor";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { shortTimeAgo } from "@/lib/formatTime";
import { gitStatusFromKind, type GitTicket, type GitTimelineActivity } from "@/lib/gitActivity";
import { cn } from "@/lib/utils";

function TicketIcon({ ticket }: { ticket: GitTicket }) {
  const Icon = ticket.type === "issue" ? CircleDot : GitPullRequest;
  return <Icon className={cn("size-4 shrink-0", ticket.type === "issue" ? "text-emerald-500" : "text-violet-500")} />;
}

function ticketType(ticket: GitTicket) {
  return ticket.type === "issue" ? "Issue" : "Pull request";
}

export function WorkItemContextHeader({ ticket, repository, onOpen }: { ticket: GitTicket; repository: string; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="flex w-full items-center gap-2 rounded-t-lg border border-b-0 border-border bg-secondary/45 px-3 py-2 text-left transition-colors hover:bg-secondary"><TicketIcon ticket={ticket} /><span className="min-w-0 flex-1 truncate text-xs font-medium">{ticket.subject}</span><span className="shrink-0 font-mono text-[10px] text-muted-foreground">{repository}</span></button>;
}

/** A Git event rendered as a contextual channel reference. The underlying NIP-34/NIP-22 event remains the source of truth. */
export function GitTimelineRow({ entry, members, onOpen, commentEntries, activities = [] }: { entry: GitChannelTimelineEntry; members: ReadonlySet<string>; onOpen: (ticket: GitTicket) => void; commentEntries?: readonly Extract<GitChannelTimelineEntry, { type: "git-comment" }>[]; activities?: readonly GitTimelineActivity[] }) {
  const { activity } = entry;
  const ticket = activity.ticket;
  const repository = activity.repository.identifier;
  const actor = activity.type === "ticket-opened" ? ticket.author : activity.type === "comment" ? activity.comment.author : activity.status.author;
  const { earlierComments, laterComments } = useMemo(() => {
    if (entry.type !== "git-comment") return { earlierComments: 0, laterComments: 0 };
    const ticketComments = activities
      .filter((candidate): candidate is Extract<GitTimelineActivity, { type: "comment" }> => candidate.type === "comment" && candidate.ticket.id === ticket.id)
      .sort((a, b) => a.createdAt - b.createdAt || a.comment.id.localeCompare(b.comment.id));
    const shownIds = new Set((commentEntries ?? [entry]).map((commentEntry) => commentEntry.activity.comment.id));
    const shownIndexes = ticketComments.flatMap((comment, index) => shownIds.has(comment.comment.id) ? [index] : []);
    if (shownIndexes.length === 0) return { earlierComments: 0, laterComments: 0 };
    return { earlierComments: Math.min(...shownIndexes), laterComments: ticketComments.length - Math.max(...shownIndexes) - 1 };
  }, [activities, commentEntries, entry, ticket.id]);

  if (entry.type === "git-ticket-opened") {
    const action = ticket.type === "issue" ? "opened an issue" : "opened a pull request";
    return (
      <article data-git-entry className="my-4 flex gap-2.5 px-2.5">
        <Avatar className="mt-1 size-8 shrink-0"><ActorAvatar pubkey={actor} /></Avatar>
        <div className="min-w-0 flex-1">
          <p className="text-sm"><ActorName pubkey={actor} members={members} /><span className="text-muted-foreground"> {action} in {repository} · {shortTimeAgo(entry.createdAt)}</span></p>
          <button type="button" onClick={() => onOpen(ticket)} className="mt-2 block w-full rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-colors hover:bg-secondary/30">
            <div className="flex items-center gap-2"><TicketIcon ticket={ticket} /><span className="text-xs text-muted-foreground">{ticketType(ticket)}</span></div>
            <p className="mt-2 text-sm font-semibold">{ticket.subject}</p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">Follow the work item here without leaving the channel.</p>
            <span className="mt-3 flex items-center gap-1.5 text-xs text-primary"><MessageCircle className="size-3.5" />Open conversation</span>
          </button>
        </div>
      </article>
    );
  }

  if (entry.type === "git-comment") {
    const comments = commentEntries ?? [entry];
    return (
      <article data-git-entry className="my-4 px-2.5">
        <WorkItemContextHeader ticket={ticket} repository={repository} onOpen={() => onOpen(ticket)} />
        <div className="rounded-b-lg border border-border bg-card px-3 py-3 shadow-sm">
          {earlierComments > 0 && <button type="button" onClick={() => onOpen(ticket)} className="mb-3 text-[10px] text-muted-foreground/70 hover:text-muted-foreground">↑ Earlier comments</button>}
          <div className="space-y-3">{comments.map((commentEntry) => <GitCommentRow key={commentEntry.id} entry={commentEntry} members={members} />)}</div>
          {laterComments > 0 && <button type="button" onClick={() => onOpen(ticket)} className="mt-3 text-[10px] text-muted-foreground/70 hover:text-muted-foreground">↓ Later comments</button>}
          <button type="button" onClick={() => onOpen(ticket)} className="mt-3 flex items-center gap-1.5 text-xs text-primary hover:underline"><MessageCircle className="size-3.5" />View conversation in context</button>
        </div>
      </article>
    );
  }

  const status = gitStatusFromKind(entry.activity.status.kind, ticket.kind);
  return <div className="my-3 px-2.5"><button data-git-entry type="button" onClick={() => onOpen(ticket)} className="flex w-full items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-left text-xs hover:bg-secondary"><TicketIcon ticket={ticket} /><span className="inline-flex items-center gap-1"><ActorName pubkey={actor} members={members} /></span><span className="text-muted-foreground">changed status to</span><span className="font-medium capitalize">{status}</span><span className="truncate text-muted-foreground">· {ticket.subject}</span></button></div>;
}

function GitCommentRow({ entry, members }: { entry: Extract<GitChannelTimelineEntry, { type: "git-comment" }>; members: ReadonlySet<string> }) {
  const { comment } = entry.activity;
  return <div className="flex gap-2.5"><Avatar className="size-8 shrink-0"><ActorAvatar pubkey={comment.author} /></Avatar><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><ActorName pubkey={comment.author} members={members} /><span className="text-xs text-muted-foreground">commented · {shortTimeAgo(entry.createdAt)}</span></div><p className="mt-1 whitespace-pre-wrap text-sm leading-5">{comment.content}</p></div></div>;
}

function ActorAvatar({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <><AvatarImage src={author.data?.metadata?.picture} alt={name} /><AvatarFallback className="text-[10px] font-semibold">{name.slice(0, 1)}</AvatarFallback></>;
}

function ActorName({ pubkey, members }: { pubkey: string; members: ReadonlySet<string> }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <><span className="text-sm font-semibold">{name}</span>{isCommunityGuest(pubkey, members) && <span className="ml-1 rounded border border-border px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Guest</span>}</>;
}

function TicketPanelBody({ ticket, members, activities }: { ticket: GitTicket; members: ReadonlySet<string>; activities: readonly GitTimelineActivity[] }) {
  const [jsonOpen, setJsonOpen] = useState(false);
  const { comments, latestStatus } = useMemo(() => {
    const related = activities.filter((activity) => activity.ticket.id === ticket.id);
    return {
      comments: related.filter((activity): activity is Extract<GitTimelineActivity, { type: "comment" }> => activity.type === "comment").sort((a, b) => a.createdAt - b.createdAt || a.comment.id.localeCompare(b.comment.id)),
      latestStatus: related.filter((activity): activity is Extract<GitTimelineActivity, { type: "status-change" }> => activity.type === "status-change").sort((a, b) => b.createdAt - a.createdAt || a.status.event.id.localeCompare(b.status.event.id))[0],
    };
  }, [activities, ticket.id]);
  const status = gitStatusFromKind(latestStatus?.status.kind, ticket.kind);
  const repository = ticket.repositoryAddress?.identifier ?? "Unknown repository";

  return <div className="flex min-h-0 flex-1 flex-col"><div className="min-h-0 flex-1 overflow-y-auto p-3"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><TicketIcon ticket={ticket} />{ticketType(ticket)}</div><h2 className="mt-2 break-words text-sm font-semibold">{ticket.subject}</h2><p className="mt-1 text-xs text-muted-foreground">{repository} · <span className="capitalize">{status}</span></p><div className="my-4 border-t border-border" /><p className="text-xs text-muted-foreground">This is the work item’s durable discussion. Its card in the channel is a contextual reference, not a chat thread.</p>{ticket.content && <DiscussionMessage pubkey={ticket.author} createdAt={ticket.createdAt} content={ticket.content} members={members} className="mt-4" />}<div className="mt-4 space-y-4">{comments.map(({ comment }) => <DiscussionMessage key={comment.id} pubkey={comment.author} createdAt={comment.createdAt} content={comment.content} members={members} />)}</div>{comments.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No comments yet.</p>}<Button variant="ghost" size="sm" className="mt-4" onClick={() => setJsonOpen(true)}><Braces className="mr-2 size-4" />View event JSON</Button></div><Dialog open={jsonOpen} onOpenChange={setJsonOpen}><DialogContent><DialogHeader><DialogTitle>Event JSON</DialogTitle></DialogHeader><pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(ticket.event, null, 2)}</pre></DialogContent></Dialog></div>;
}

function DiscussionMessage({ pubkey, createdAt, content, members, className }: { pubkey: string; createdAt: number; content: string; members: ReadonlySet<string>; className?: string }) {
  return <div className={cn("flex gap-2.5", className)}><Avatar className="size-8 shrink-0"><ActorAvatar pubkey={pubkey} /></Avatar><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><ActorName pubkey={pubkey} members={members} /><span className="text-xs text-muted-foreground">commented · {shortTimeAgo(createdAt)}</span></div><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5">{content}</p></div></div>;
}

export function TicketSidePanel({ ticket, members, activities, onClose }: { ticket: GitTicket | undefined; members: ReadonlySet<string>; activities: readonly GitTimelineActivity[]; onClose: () => void }) {
  const isDesktop = useIsDesktop();

  return <><aside className={cn("hidden shrink-0 overflow-hidden border-l border-border bg-chrome sidebar:flex sidebar:transition-[width] sidebar:duration-200", ticket ? "sidebar:w-[21rem]" : "sidebar:w-0")}>{ticket && <div className="flex w-[21rem] min-w-[21rem] flex-col"><div className="flex h-12 items-center border-b border-border px-3"><p className="text-sm font-semibold">Conversation</p><Button variant="ghost" size="icon" className="ml-auto size-8" onClick={onClose} aria-label="Close conversation"><X className="size-4" /></Button></div><TicketPanelBody ticket={ticket} members={members} activities={activities} /></div>}</aside>{ticket && !isDesktop && <Sheet open onOpenChange={(open) => !open && onClose()}><SheetContent side="right" className="flex w-[92vw] max-w-none flex-col p-0"><div className="flex h-12 shrink-0 items-center border-b border-border px-3"><SheetTitle className="text-sm font-semibold">Conversation</SheetTitle><Button variant="ghost" size="icon" className="ml-auto size-8" onClick={onClose} aria-label="Close conversation"><X className="size-4" /></Button></div><TicketPanelBody ticket={ticket} members={members} activities={activities} /></SheetContent></Sheet>}</>;
}

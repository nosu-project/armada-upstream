import { Braces, CircleDot, ExternalLink, GitPullRequest, Loader2, MessageCircle, Paperclip, Pencil, Trash2, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useMemo, useRef, useState } from "react";

import type { NostrEvent } from "@nostrify/nostrify";

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
import { shortTimeAgo } from "@/lib/formatTime";
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
  // One flowing, truncating sentence: separate flex spans wrap internally on
  // narrow layouts and stack the phrase three lines high.
  return <div className="my-3 px-2.5"><button data-git-entry type="button" onClick={() => onOpen(ticket)} className="flex w-full items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-left text-xs hover:bg-secondary"><TicketIcon ticket={ticket} /><p className="min-w-0 flex-1 truncate"><ActorName pubkey={actor} members={members} /><span className="text-muted-foreground"> changed status to </span><span className="font-medium capitalize">{status}</span><span className="text-muted-foreground"> · {ticket.subject}</span></p></button></div>;
}

function GitCommentRow({ entry, members }: { entry: Extract<GitChannelTimelineEntry, { type: "git-comment" }>; members: ReadonlySet<string> }) {
  const { comment } = entry.activity;
  return <div className="flex gap-2.5"><Avatar className="size-8 shrink-0"><ActorAvatar pubkey={comment.author} /></Avatar><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><ActorName pubkey={comment.author} members={members} /><span className="text-xs text-muted-foreground">commented · {shortTimeAgo(entry.createdAt)}</span></div><ChatContent event={comment.event} disableNoteEmbeds documentMarkdown className="mt-1 break-words text-sm leading-5" /></div></div>;
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
  return (
    <div className="shrink-0 border-t border-border p-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={`Comment on this ${ticket.type === "issue" ? "issue" : "pull request"}`}
        rows={2}
        className="min-h-0 resize-none text-sm"
      />
      <div className="mt-2 flex items-center justify-between gap-1.5">
        <p className="min-w-0 truncate text-[10px] text-muted-foreground">Public: repository discussion is visible outside this community.</p>
        <div className="flex shrink-0 items-center gap-1.5">
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
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label="Attach files"
          disabled={isUploading}
          onClick={() => fileInput.current?.click()}
        >
          {isUploading ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
        </Button>
        <Button size="sm" className="h-7 px-3 text-xs" disabled={sending || isUploading || !text.trim()} onClick={submit}>
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : "Comment"}
        </Button>
        </div>
      </div>
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
    const related = activities.filter((activity) => activity.ticket.id === ticket.id);
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

function DiscussionMessage({ pubkey, createdAt, event, members, className, controls }: { pubkey: string; createdAt: number; event: NostrEvent; members: ReadonlySet<string>; className?: string; controls?: DiscussionControls }) {
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

  return <><aside className={cn("hidden shrink-0 overflow-hidden bg-chrome sidebar:flex sidebar:transition-[width] sidebar:duration-200", ticket ? "border-l border-border sidebar:w-[21rem]" : "sidebar:w-0")}>{ticket && <div className="flex w-[21rem] min-w-[21rem] flex-col"><div className="flex h-12 items-center border-b border-border px-3"><p className="text-sm font-semibold">Conversation</p><Button variant="ghost" size="icon" className="ml-auto size-8" onClick={onClose} aria-label="Close conversation"><X className="size-4" /></Button></div><TicketPanelBody ticket={ticket} members={members} activities={activities} actions={actions} /></div>}</aside>{ticket && !isDesktop && <Sheet open onOpenChange={(open) => !open && onClose()}><SheetContent side="right" className="flex w-[92vw] max-w-none flex-col p-0">{/* SheetContent renders its own close control in this corner. */}<div className="flex h-12 shrink-0 items-center border-b border-border px-3"><SheetTitle className="text-sm font-semibold">Conversation</SheetTitle></div><TicketPanelBody ticket={ticket} members={members} activities={activities} actions={actions} /></SheetContent></Sheet>}</>;
}

import type { NostrEvent } from "@nostrify/nostrify";
import { Bell, ChevronLeft, MoreVertical, Search, Settings2, Users } from "lucide-react";
import { useState } from "react";

import { isGitContinuation, type GitChannelTimelineEntry } from "@/components/chat/channelTimeline";
import { GitTimelineRow, TicketSidePanel } from "@/components/chat/GitTimeline";
import { MessageRow } from "@/components/chat/MessageRow";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import type { GitComment, GitRepositoryAddress, GitTicket } from "@/lib/gitActivity";
import { GIT_ISSUE_KIND, GIT_PULL_REQUEST_KIND, NIP22_COMMENT_KIND } from "@/lib/gitActivity";
import { cn } from "@/lib/utils";

const authors = { ari: "a".repeat(64), dan: "d".repeat(64), maya: "b".repeat(64), noah: "c".repeat(64), priya: "e".repeat(64) };
const repository: GitRepositoryAddress = { kind: 30617, owner: authors.dan, identifier: "armada", coordinate: `30617:${authors.dan}:armada` };

function event(id: string, pubkey: string, kind: number, createdAt: number, content = ""): NostrEvent {
  return { id: id.repeat(64).slice(0, 64), pubkey, kind, created_at: createdAt, tags: [], content, sig: "0".repeat(128) };
}

function ticket(id: string, author: string, kind: GitTicket["kind"], subject: string, content: string, createdAt: number): GitTicket {
  return { event: event(id, author, kind, createdAt, content), id: id.repeat(64).slice(0, 64), kind, type: kind === GIT_ISSUE_KIND ? "issue" : "pull-request", subject, content, labels: [], repositoryAddress: repository, repositoryAddresses: [repository], author, createdAt };
}

function comment(id: string, author: string, workItem: GitTicket, content: string, createdAt: number): GitComment {
  return { event: event(id, author, NIP22_COMMENT_KIND, createdAt, content), id: id.repeat(64).slice(0, 64), ticketId: workItem.id, ticketKind: workItem.kind, content, author, createdAt };
}

const now = Math.floor(Date.now() / 1000);
const notificationControls = ticket("1", authors.maya, GIT_PULL_REQUEST_KIND, "Add per-channel notification controls", "Could we make “Mentions only” the default for newly joined channels? That avoids a surprise flood after accepting an invite.", now - 12 * 60);
const voiceReconnect = ticket("2", authors.noah, GIT_ISSUE_KIND, "Voice reconnect loses the selected input device", "I can reproduce this after switching from Bluetooth to the phone microphone during a reconnect.", now - 4 * 60);

const gitEntries: GitChannelTimelineEntry[] = [
  { type: "git-ticket-opened", id: "git:notification-controls", createdAt: now - 12 * 60, activity: { type: "ticket-opened", ticket: notificationControls, repository, createdAt: now - 12 * 60 } },
  { type: "git-comment", id: "git:notification-comment-1", createdAt: now - 8 * 60, activity: { type: "comment", ticket: notificationControls, repository, createdAt: now - 8 * 60, comment: comment("3", authors.dan, notificationControls, "Could we make “Mentions only” the default for newly joined channels? That avoids a surprise flood after accepting an invite.", now - 8 * 60) } },
  { type: "git-comment", id: "git:notification-comment-2", createdAt: now - 7 * 60, activity: { type: "comment", ticket: notificationControls, repository, createdAt: now - 7 * 60, comment: comment("4", authors.maya, notificationControls, "Yes — I added that to the latest commit and migration path.", now - 7 * 60) } },
  { type: "git-comment", id: "git:notification-comment-3", createdAt: now - 5 * 60, activity: { type: "comment", ticket: notificationControls, repository, createdAt: now - 5 * 60, comment: comment("5", authors.priya, notificationControls, "The empty-state copy should explain that channel defaults can still be changed later.", now - 5 * 60) } },
  { type: "git-comment", id: "git:notification-comment-4", createdAt: now - 3 * 60, activity: { type: "comment", ticket: notificationControls, repository, createdAt: now - 3 * 60, comment: comment("6", authors.dan, notificationControls, "Good call. The migration behavior and empty state both look ready after that.", now - 3 * 60) } },
  { type: "git-ticket-opened", id: "git:voice-reconnect", createdAt: now - 4 * 60, activity: { type: "ticket-opened", ticket: voiceReconnect, repository, createdAt: now - 4 * 60 } },
  { type: "git-comment", id: "git:voice-comment-1", createdAt: now - 4 * 60, activity: { type: "comment", ticket: voiceReconnect, repository, createdAt: now - 4 * 60, comment: comment("7", authors.noah, voiceReconnect, "I can reproduce this after switching from Bluetooth to the phone microphone during a reconnect.", now - 4 * 60) } },
  { type: "git-comment", id: "git:voice-comment-2", createdAt: now - 2 * 60, activity: { type: "comment", ticket: voiceReconnect, repository, createdAt: now - 2 * 60, comment: comment("8", authors.dan, voiceReconnect, "I found the device ID being cleared before the reconnect state is restored. I’ll send a fix shortly.", now - 2 * 60) } },
  { type: "git-comment", id: "git:notification-comment-5", createdAt: now - 60, activity: { type: "comment", ticket: notificationControls, repository, createdAt: now - 60, comment: comment("9", authors.maya, notificationControls, "Updated both. I’ll mark this ready for review after the screenshot test finishes.", now - 60) } },
  { type: "git-comment", id: "git:voice-comment-3", createdAt: now, activity: { type: "comment", ticket: voiceReconnect, repository, createdAt: now, comment: comment("a", authors.noah, voiceReconnect, "Thanks — I’ll verify the Android build once it lands.", now) } },
];

function ChannelRow({ name, active, unread }: { name: string; active?: boolean; unread?: boolean }) {
  return <button type="button" className={cn("flex w-full items-center gap-2 rounded-md py-1.5 pl-4 pr-2 text-left text-sm transition-colors", active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")}><span className="text-base leading-none">#</span><span className="min-w-0 flex-1 truncate">{name}</span>{unread && <span className="size-2 rounded-full bg-primary" />}</button>;
}

function adjacentCommentEntries(entries: readonly GitChannelTimelineEntry[], index: number, entry: Extract<GitChannelTimelineEntry, { type: "git-comment" }>) {
  const comments = [entry];
  for (let cursor = index + 1; cursor < entries.length; cursor++) {
    const candidate = entries[cursor];
    if (!isGitContinuation(comments[comments.length - 1], candidate)) break;
    comments.push(candidate as Extract<GitChannelTimelineEntry, { type: "git-comment" }>);
  }
  return comments;
}

function GitEntryRows({ entries, members, onOpen }: { entries: readonly GitChannelTimelineEntry[]; members: ReadonlySet<string>; onOpen: (ticket: GitTicket) => void }) {
  const activities = entries.map((entry) => entry.activity);
  return <>{entries.map((entry, index) => {
    if (isGitContinuation(entries[index - 1], entry)) return null;
    const commentEntries = entry.type === "git-comment" ? adjacentCommentEntries(entries, index, entry) : undefined;
    return <GitTimelineRow key={entry.id} entry={entry} members={members} onOpen={onOpen} commentEntries={commentEntries} activities={activities} />;
  })}</>;
}

export function GitMockupSixPage() {
  const [openTicket, setOpenTicket] = useState<GitTicket | undefined>(notificationControls);
  const members = new Set(Object.values(authors).filter((author) => author !== authors.priya));
  const activities = gitEntries.map((entry) => entry.activity);

  return <div className="flex h-full min-h-0 bg-background"><ServerRail /><ChannelSidebarView title="Armada contributors" subtitle="Community" className="hidden sidebar:flex" addChannelDisabled><button type="button" className="flex w-full items-center gap-2 rounded-md py-1.5 pl-4 pr-2 text-left text-sm text-muted-foreground hover:bg-secondary/60"><Bell className="size-4" />Mentions<span className="ml-auto rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">2</span></button><ChannelRow name="general" /><ChannelRow name="design" /><ChannelRow name="engineering" active unread /><ChannelRow name="release-work" /></ChannelSidebarView><main className="flex min-w-0 flex-1 flex-col safe-area-top"><header className="relative mx-2 mt-3 flex h-12 shrink-0 items-center gap-1.5 bg-chrome px-2 clip-corner-lg sidebar:px-3"><Button variant="ghost" size="icon" className="size-9 shrink-0 sidebar:hidden" aria-label="Back to channels"><ChevronLeft className="size-5" /></Button><span className="text-xl text-muted-foreground">#</span><div className="min-w-0 flex-1"><h1 className="truncate font-semibold leading-tight">engineering</h1><p className="truncate text-xs text-muted-foreground">Build notes, reviews, and implementation discussion</p></div><Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Search channel"><Search className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Community members"><Users className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Channel settings"><Settings2 className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="More channel options"><MoreVertical className="size-4" /></Button></header><div className="flex min-h-0 flex-1"><section className="min-w-0 flex-1 overflow-y-auto pb-6 pt-5"><div className="w-full"><div className="mb-5 border-b border-border px-4 pb-5"><h2 className="text-xl font-bold">Welcome to #engineering</h2><p className="mt-2 text-sm leading-5 text-muted-foreground">Discuss implementation with the community. Connected repository activity can appear naturally in this conversation.</p></div><div className="px-2 sidebar:px-4"><div className="mb-4 flex items-center gap-3 text-[11px] font-medium text-muted-foreground"><span className="h-px flex-1 bg-border" />TODAY<span className="h-px flex-1 bg-border" /></div><MessageRow pubkey={authors.ari} identityOverride={{ name: "Ari Kline", suffix: "dev", color: "#d97706" }} createdAt={now - 55 * 60}><p className="text-sm leading-5">I’m testing the new notification settings now. The channel-level defaults look good on desktop.</p></MessageRow><GitEntryRows entries={gitEntries.slice(0, 3)} members={members} onOpen={setOpenTicket} /><MessageRow pubkey={authors.ari} identityOverride={{ name: "Ari Kline", suffix: "dev", color: "#d97706" }} createdAt={now - 6 * 60}><p className="text-sm leading-5">I’m updating the desktop screenshots now. The new defaults read clearly in the channel picker.</p></MessageRow><GitEntryRows entries={gitEntries.slice(3, 4)} members={members} onOpen={setOpenTicket} /><MessageRow pubkey={authors.maya} identityOverride={{ name: "Maya Chen", suffix: "dev", color: "#8b5cf6" }} createdAt={now - 2 * 60}><p className="text-sm leading-5">I’ll post the release checklist here before lunch.</p></MessageRow><GitEntryRows entries={gitEntries.slice(4)} members={members} onOpen={setOpenTicket} /></div></div></section><TicketSidePanel ticket={openTicket} members={members} activities={activities} onClose={() => setOpenTicket(undefined)} /></div></main></div>;
}

import {
  Bell,
  ChevronLeft,
  CircleDot,
  MessageCircle,
  MoreVertical,
  Paperclip,
  Search,
  SendHorizontal,
  Settings2,
  Smile,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";

import { MessageRow } from "@/components/chat/MessageRow";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Actor = {
  name: string;
  handle: string;
  initials: string;
  color: string;
  time: string;
};

type WorkItem = {
  number: string;
  title: string;
  repository: string;
  label: string;
  openedBy: Actor;
  replies: number;
};

type WorkItemComment = {
  actor: Actor;
  body: string;
  earlierComments?: number;
  laterComments?: number;
};

const people = {
  alex: { name: "Alex Gleason", handle: "@alexgleason", initials: "AG", color: "#2563eb" },
  chad: { name: "Chad Curtis", handle: "@chadcurtis", initials: "CC", color: "#059669" },
  centauri: { name: "Centauri", handle: "@CentauriAgent", initials: "CA", color: "#7c3aed" },
  derek: { name: "Derek Ross", handle: "@derekross", initials: "DR", color: "#d97706" },
  maryKate: { name: "Mary Kate", handle: "@marykatefain", initials: "MK", color: "#db2777" },
  sam: { name: "Sam Thomson", handle: "@sam_thomson", initials: "ST", color: "#0891b2" },
} satisfies Record<string, Omit<Actor, "time">>;

const reactionEmoji: WorkItem = {
  number: "#91",
  title: "Chat reactions display raw URL text instead of emoji",
  repository: "armada",
  label: "Bug",
  openedBy: { ...people.centauri, time: "28m" },
  replies: 3,
};

const nativeEmbeds: WorkItem = {
  number: "#92",
  title: "Embedding/rendering various formats of native events",
  repository: "armada",
  label: "New feature",
  openedBy: { ...people.maryKate, time: "16m" },
  replies: 2,
};

const reactionEmojiComments: WorkItemComment[] = [
  { actor: { ...people.derek, time: "24m" }, body: "I can confirm this is visible in the community: a reaction ends up showing its image URL instead of the emoji." },
  { actor: { ...people.chad, time: "20m" }, body: "I traced the display path. The reaction renderer needs to resolve the custom-emoji tag before falling back to plain text.", laterComments: 1 },
  { actor: { ...people.centauri, time: "17m" }, body: "Added the reproduction details to the issue so the fix can be verified against the original report.", earlierComments: 2 },
];

const nativeEmbedComments: WorkItemComment[] = [
  { actor: { ...people.sam, time: "11m" }, body: "I’ll take this. We should render nevent, nprofile, npub, and naddr references as native embeds rather than raw nostr: links." },
  { actor: { ...people.alex, time: "8m" }, body: "Agreed. Nested event references should use the same embed path so they stay readable in chat." },
];

function ChannelRow({ name, active, unread }: { name: string; active?: boolean; unread?: boolean }) {
  return <button type="button" className={cn("flex w-full items-center gap-2 rounded-md py-1.5 pl-4 pr-2 text-left text-sm transition-colors", active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")}><span className="text-base leading-none">#</span><span className="min-w-0 flex-1 truncate">{name}</span>{unread && <span className="size-2 rounded-full bg-primary" />}</button>;
}

function ItemIcon() {
  return <CircleDot className="size-4 shrink-0 text-emerald-500" />;
}

function ContextHeader({ item, onOpen }: { item: WorkItem; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="flex w-full items-center gap-2 rounded-t-lg border border-b-0 border-border bg-secondary/45 px-3 py-2 text-left transition-colors hover:bg-secondary"><ItemIcon /><span className="min-w-0 flex-1 truncate text-xs font-medium">{item.title}</span><span className="shrink-0 font-mono text-[10px] text-muted-foreground">{item.repository} · {item.number}</span></button>;
}

function WorkItemActivity({ item, onOpen }: { item: WorkItem; onOpen: () => void }) {
  const actor = item.openedBy;

  return <article className="mx-auto my-4 flex max-w-2xl gap-2.5"><Avatar className="mt-1 size-8 shrink-0"><AvatarFallback style={{ backgroundColor: actor.color }} className="text-[10px] font-semibold text-white">{actor.initials}</AvatarFallback></Avatar><div className="min-w-0 flex-1"><p className="text-sm"><span className="font-semibold">{actor.name}</span><span className="text-muted-foreground"> opened an issue in {item.repository} · {actor.time}</span></p><button type="button" onClick={onOpen} className="mt-2 block w-full rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-colors hover:bg-secondary/30"><div className="flex items-center gap-2"><ItemIcon /><span className="text-xs text-muted-foreground">Issue</span><span className="font-mono text-[10px] text-muted-foreground">{item.number}</span><span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">{item.label}</span></div><p className="mt-2 text-sm font-semibold">{item.title}</p><p className="mt-1 text-sm leading-5 text-muted-foreground">A connected Git item: open its durable discussion without leaving #armada.</p><span className="mt-3 flex items-center gap-1.5 text-xs text-primary"><MessageCircle className="size-3.5" />{item.replies} Git comments · Open conversation</span></button></div></article>;
}

function CommentActivity({ item, comments, onOpen }: { item: WorkItem; comments: WorkItemComment[]; onOpen: () => void }) {
  const { earlierComments = 0, laterComments = 0 } = comments[0] ?? {};

  return <article className="mx-auto my-4 max-w-2xl"><ContextHeader item={item} onOpen={onOpen} /><div className="rounded-b-lg border border-border bg-card px-3 py-3 shadow-sm">{earlierComments > 0 && <button type="button" onClick={onOpen} className="mb-3 text-[10px] text-muted-foreground/70 hover:text-muted-foreground">↑ Earlier Git comments</button>}<div className="space-y-3">{comments.map(({ actor, body }) => <div key={`${actor.name}-${actor.time}`} className="flex gap-2.5"><Avatar className="size-8 shrink-0"><AvatarFallback style={{ backgroundColor: actor.color }} className="text-[10px] font-semibold text-white">{actor.initials}</AvatarFallback></Avatar><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2"><span className="text-sm font-semibold">{actor.name}</span><span className="text-xs text-muted-foreground">{actor.handle} · commented · {actor.time}</span></div><p className="mt-1 text-sm leading-5 text-foreground">{body}</p></div></div>)}</div>{laterComments > 0 && <button type="button" onClick={onOpen} className="mt-3 text-[10px] text-muted-foreground/70 hover:text-muted-foreground">↓ Later Git comments</button>}<button type="button" onClick={onOpen} className="mt-3 flex items-center gap-1.5 text-xs text-primary hover:underline"><MessageCircle className="size-3.5" />View all {item.replies} Git comments in context</button></div></article>;
}

function Composer() {
  const [message, setMessage] = useState("");

  return <div className="shrink-0 border-t border-border bg-background px-3 pb-3 pt-2 sidebar:px-5"><div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-border bg-card p-2 shadow-sm"><Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label="Attach a file"><Paperclip className="size-4" /></Button><textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={1} placeholder="Message #armada" className="max-h-28 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground" /><Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label="Add emoji"><Smile className="size-4" /></Button><Button size="icon" className="size-8 shrink-0" aria-label="Send message" disabled={!message.trim()}><SendHorizontal className="size-4" /></Button></div><p className="mx-auto mt-1 max-w-3xl pl-1 text-[10px] text-muted-foreground">Concord message · encrypted for Team Soapbox members</p></div>;
}

export function GitMockupFourPage() {
  const [contextItem, setContextItem] = useState<WorkItem | null>(reactionEmoji);
  const now = Date.now() / 1000;
  const contextComments = contextItem === reactionEmoji ? reactionEmojiComments : nativeEmbedComments;

  return <div className="flex h-full min-h-0 bg-background"><ServerRail /><ChannelSidebarView title="Team Soapbox" subtitle="Community" className="hidden sidebar:flex" addChannelDisabled><button type="button" className="flex w-full items-center gap-2 rounded-md py-1.5 pl-4 pr-2 text-left text-sm text-muted-foreground hover:bg-secondary/60"><Bell className="size-4" />Mentions<span className="ml-auto rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">3</span></button><div className="my-2 border-t border-border" /><p className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Applications</p><ChannelRow name="argora" /><ChannelRow name="armada" active unread /><ChannelRow name="ditto" /><ChannelRow name="shakespeare" /><p className="mt-3 px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Team Soapbox</p><ChannelRow name="ai" /><ChannelRow name="marketing" /><ChannelRow name="general" /><ChannelRow name="random" /><ChannelRow name="meeting" /></ChannelSidebarView>
    <main className="flex min-w-0 flex-1 flex-col safe-area-top"><header className="relative mx-2 mt-3 flex h-12 shrink-0 items-center gap-1.5 bg-chrome px-2 clip-corner-lg sidebar:px-3"><Button variant="ghost" size="icon" className="size-9 shrink-0 sidebar:hidden" aria-label="Back to channels"><ChevronLeft className="size-5" /></Button><span className="text-xl text-muted-foreground">#</span><div className="min-w-0 flex-1"><h1 className="truncate font-semibold leading-tight">armada</h1><p className="truncate text-xs text-muted-foreground">Armada app discussion with connected Git activity</p></div><Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Search channel"><Search className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Community members"><Users className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Channel settings"><Settings2 className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="More channel options"><MoreVertical className="size-4" /></Button></header>
      <div className="flex min-h-0 flex-1"><div className="flex min-w-0 flex-1 flex-col"><section className="min-h-0 flex-1 overflow-y-auto pb-4 pt-5"><div className="mx-auto max-w-3xl"><div className="mb-5 border-b border-border px-4 pb-5"><h2 className="text-xl font-bold">Welcome to #armada</h2><p className="mt-2 text-sm leading-5 text-muted-foreground">This application channel keeps normal Concord conversation and connected Git work in one timeline. Chat posts stay encrypted for the community; issue comments remain attached to their Git item.</p></div><div className="px-2 sidebar:px-4"><div className="mb-4 flex items-center gap-3 text-[11px] font-medium text-muted-foreground"><span className="h-px flex-1 bg-border" />TODAY<span className="h-px flex-1 bg-border" /></div><MessageRow pubkey="mock-derek" identityOverride={{ name: people.derek.name, suffix: "derekross", color: people.derek.color }} createdAt={now - 32 * 60}><p className="text-sm leading-5">This is a normal Concord chat post. I noticed reactions showing raw image URLs in #armada.</p></MessageRow><WorkItemActivity item={reactionEmoji} onOpen={() => setContextItem(reactionEmoji)} /><CommentActivity item={reactionEmoji} comments={reactionEmojiComments.slice(0, 2)} onOpen={() => setContextItem(reactionEmoji)} /><MessageRow pubkey="mock-chad" identityOverride={{ name: people.chad.name, suffix: "chadcurtis", color: people.chad.color }} createdAt={now - 14 * 60}><p className="text-sm leading-5">Look at how this Concord chat post is interspersed with Git content. It is still a normal channel message, not a comment on the issue above.</p></MessageRow><CommentActivity item={reactionEmoji} comments={reactionEmojiComments.slice(2)} onOpen={() => setContextItem(reactionEmoji)} /><WorkItemActivity item={nativeEmbeds} onOpen={() => setContextItem(nativeEmbeds)} /><CommentActivity item={nativeEmbeds} comments={nativeEmbedComments} onOpen={() => setContextItem(nativeEmbeds)} /><MessageRow pubkey="mock-mary-kate" identityOverride={{ name: people.maryKate.name, suffix: "marykatefain", color: people.maryKate.color }} createdAt={now - 3 * 60}><p className="text-sm leading-5">The channel gives the team the surrounding context, while the Git item keeps the durable implementation discussion and state.</p></MessageRow></div></div></section><Composer /></div>
        <aside className={cn("hidden shrink-0 overflow-hidden border-l border-border bg-chrome sidebar:flex sidebar:transition-[width] sidebar:duration-200", contextItem ? "sidebar:w-[21rem]" : "sidebar:w-0")}>{contextItem && <div className="flex w-[21rem] min-w-[21rem] flex-col"><div className="flex h-12 items-center border-b border-border px-3"><p className="text-sm font-semibold">Conversation</p><Button variant="ghost" size="icon" onClick={() => setContextItem(null)} className="ml-auto size-8" aria-label="Close conversation"><X className="size-4" /></Button></div><div className="min-h-0 flex-1 overflow-y-auto p-3"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><ItemIcon />Issue · {contextItem.number}</div><h3 className="mt-2 text-sm font-semibold">{contextItem.title}</h3><p className="mt-1 text-xs text-muted-foreground">{contextItem.repository} · Open</p><div className="my-4 border-t border-border" /><p className="text-xs leading-5 text-muted-foreground">This is the Git item’s durable discussion. The inline blocks in #armada are contextual references, not chat threads.</p><div className="mt-4 space-y-4">{contextComments.map(({ actor, body }) => <div key={`${actor.name}-${actor.time}`} className="rounded-lg border border-border bg-background p-3"><p className="text-xs font-semibold">{actor.name} <span className="font-normal text-muted-foreground">{actor.handle} · {actor.time}</span></p><p className="mt-1 text-sm leading-5">{body}</p></div>)}</div></div><div className="border-t border-border p-3"><button type="button" className="w-full rounded-md border border-border bg-background px-3 py-2 text-left text-sm text-muted-foreground">Add a Git comment…</button></div></div>}</aside>
      </div>
    </main>
  </div>;
}

import { bytesToHex } from "@noble/hashes/utils.js";
import { Hash, Loader2, LogOut, MoreVertical, Plus, Reply, Send, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { ChatContent } from "@/components/chat/ChatContent";
import { MemberList } from "@/components/chat/MemberList";
import { MessageRow } from "@/components/chat/MessageRow";
import { InviteConcordDialog } from "@/components/dialogs/InviteConcordDialog";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConcordActions } from "@/hooks/useConcordActions";
import { useConcordChannelMessages, useConcordReactions, useSendConcordMessage } from "@/hooks/useConcordChannel";
import { useConcordCommunity } from "@/hooks/useConcordList";
import { useConcordCommunityActions } from "@/hooks/useConcordCommunityActions";
import { concordMembers, useConcordRosterActions } from "@/hooks/useConcordRoster";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isAdmin as rosterIsAdmin } from "@/lib/concord/roles";
import type { OpenedMessage } from "@/lib/concord/envelope";
import { KIND_COMMUNITY_REACTION } from "@/lib/concord/kinds";
import { cn } from "@/lib/utils";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Adapt a decrypted Concord message to the shared `NostrEvent` shape so it
 * renders through the SAME `MessageRow` + `ChatContent` path as NIP-29 group
 * chat and DMs — author profile (npub → name/avatar), rich content, emoji,
 * media, mentions. The inner event's id/author/tags/content are authentic
 * (verified on open); the sig is omitted (rendering never re-verifies it).
 */
function openedToEvent(m: OpenedMessage): NostrEvent {
  return {
    id: m.messageId,
    pubkey: m.author,
    created_at: Math.floor(m.ms / 1000),
    kind: m.kind,
    tags: m.tags,
    content: m.content,
    sig: "",
  };
}

/**
 * A Concord (end-to-end-encrypted) community: its channels + sealed chat. Lives
 * at `/c/:communityId`, rehydrated from the encrypted membership list. No host
 * reads these messages — they're decrypted client-side from opaque relay blobs.
 */
export function ConcordPage() {
  const { communityId } = useParams<{ communityId: string }>();
  const { user } = useCurrentUser();
  const community = useConcordCommunity(communityId);
  const [channelIdHex, setChannelIdHex] = useState<string | null>(null);

  const channel = useMemo(() => {
    if (!community) return undefined;
    const selected = channelIdHex
      ? community.channels.find((c) => bytesToHex(c.id) === channelIdHex)
      : community.channels[0];
    return selected ?? community.channels[0];
  }, [community, channelIdHex]);

  const { data: messages, isLoading } = useConcordChannelMessages(community, channel);
  const { data: reactions } = useConcordReactions(community, channel);
  const { mutateAsync: send, isPending: sending } = useSendConcordMessage(community, channel);
  const { createChannel, isAddingChannel } = useConcordActions();
  const { leave, isLeaving } = useConcordCommunityActions(community);
  const { roster, setAdmin } = useConcordRosterActions(community);
  const navigateTo = useNavigate();
  const [draft, setDraft] = useState("");
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [membersVisible, setMembersVisible] = useState(true);
  const [replyTo, setReplyTo] = useState<{ id: string; author: string } | null>(null);

  if (!communityId) return <Navigate to="/" replace />;

  const handleSend = async () => {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    const reference = replyTo?.id;
    setReplyTo(null);
    try {
      await send({ content, reference });
    } catch {
      setDraft(content); // restore on failure
    }
  };

  const handleCreateChannel = async () => {
    const name = newChannelName.trim();
    if (!name || !community) return;
    try {
      const updated = await createChannel({ community, name });
      const added = updated.channels[updated.channels.length - 1];
      setChannelIdHex(bytesToHex(added.id));
      setNewChannelName("");
      setCreatingChannel(false);
    } catch {
      // keep the input open so the user can retry
    }
  };

  const handleReact = async (targetId: string, emoji: string) => {
    try {
      await send({ content: emoji, kind: KIND_COMMUNITY_REACTION, reference: targetId });
    } catch {
      // best-effort
    }
  };

  const handleLeave = async () => {
    try {
      await leave();
      navigateTo("/");
    } catch {
      // best-effort
    }
  };

  // Adapt the folded Concord roster to the shared MemberList's props: the owner
  // + admins go in `admins` (with a synthetic "admin" role string the shared row
  // understands), everyone else granted a role is a plain member.
  const memberPubkeys = roster ? concordMembers(roster).map((m) => m.pubkey) : [];
  const ownerHex = roster?.ownerHex;
  const memberAdmins = roster
    ? memberPubkeys
        .filter((pk) => pk === ownerHex || rosterIsAdmin(roster.roster, pk))
        .map((pubkey) => ({ pubkey, roles: ["admin"] }))
    : [];
  const iAmOwner = Boolean(user && ownerHex && user.pubkey === ownerHex);

  /** Map the shared MemberList's role-string action onto Concord's grant model. */
  const handleSetRole = (pubkey: string, roles: string[]) => {
    setAdmin({ member: pubkey, admin: roles.includes("admin") }).catch(() => {});
  };

  return (
    <>
      <ServerRail />

      {/* Channel list */}
      <aside className="relative flex flex-col w-60 shrink-0 bg-chrome">
        <div className="pl-5 pr-3 pt-5 pb-3 flex items-center gap-2">
          <ShieldCheck className="size-4 text-success shrink-0" />
          <div className="min-w-0">
            <h2 className="font-semibold truncate leading-tight tracking-wide text-sm">
              {community?.name ?? "…"}
            </h2>
            <span className="text-[11px] text-success/80 leading-tight">End-to-end encrypted</span>
          </div>
        </div>
        <div className="mx-3 h-0.5 shrink-0 bg-chrome-divider" />
        <div className="flex-1 overflow-y-auto px-1 pt-[11px] pb-2 space-y-0.5">
          <div className="flex items-center justify-between pl-4 pr-2 py-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Channels
            </span>
            {user && community && (
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label="Add channel"
                onClick={() => setCreatingChannel((v) => !v)}
              >
                <Plus className="size-4" />
              </Button>
            )}
          </div>

          {creatingChannel && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleCreateChannel();
              }}
              className="px-2 py-1 flex items-center gap-1"
            >
              <Input
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                placeholder="new-channel"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setCreatingChannel(false);
                    setNewChannelName("");
                  }
                }}
                className="h-7 text-sm"
              />
              <Button type="submit" size="icon" className="size-7 shrink-0" disabled={isAddingChannel || !newChannelName.trim()}>
                {isAddingChannel ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              </Button>
            </form>
          )}

          {!community ? (
            <div className="space-y-2 px-2 py-1">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : (
            community.channels.map((c) => {
              const idHex = bytesToHex(c.id);
              const active = channel && bytesToHex(channel.id) === idHex;
              return (
                <button
                  key={idHex}
                  type="button"
                  onClick={() => setChannelIdHex(idHex)}
                  className={cn(
                    "flex w-full items-center gap-2 pl-4 pr-2 py-1.5 text-sm transition-colors text-left",
                    "text-muted-foreground hover:text-foreground",
                    active && "text-foreground font-medium",
                  )}
                >
                  <Hash className="size-4 shrink-0" />
                  <span className="truncate">{c.name}</span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Chat */}
      <main className="flex-1 min-w-0 flex flex-col">
        <header className="relative h-12 mx-2 mt-3 px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
          <Hash className="size-5 text-muted-foreground shrink-0" />
          <h1 className="font-semibold truncate leading-tight">{channel?.name ?? "…"}</h1>
          <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-success">
            <ShieldCheck className="size-3" /> Encrypted
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {user && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8" aria-label="Invite people" onClick={() => setInviteOpen(true)}>
                    <UserPlus className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Invite people</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("size-8 text-muted-foreground", membersVisible && "text-foreground")}
                  aria-label={membersVisible ? "Hide members" : "Show members"}
                  aria-pressed={membersVisible}
                  onClick={() => setMembersVisible((v) => !v)}
                >
                  <Users className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{membersVisible ? "Hide members" : "Show members"}</TooltipContent>
            </Tooltip>
            {user && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8" aria-label="Community actions">
                    <MoreVertical className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48 p-2">
                  <DropdownMenuItem
                    className="gap-3 px-3 py-2.5 text-destructive focus:text-destructive"
                    disabled={isLeaving}
                    onClick={handleLeave}
                  >
                    <LogOut className="size-4" />
                    Leave community
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>

        {/* Chat + members. Member panel mirrors the NIP-29 GroupPage: in-flow
            animated-width on desktop, full-screen overlay on mobile. */}
        <div className="relative flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Decrypting…
            </div>
          ) : messages && messages.length > 0 ? (
            messages.map((m, i) => {
              const event = openedToEvent(m);
              const prev = messages[i - 1];
              const continuation =
                Boolean(prev) &&
                prev.author === m.author &&
                m.ms - prev.ms < 5 * 60 * 1000;
              const tallies = reactions?.get(m.messageId);
              const replyTarget = m.tags.find((t) => t[0] === "e" && t[3] === "reply")?.[1];
              return (
                <MessageRow
                  key={m.messageId}
                  pubkey={m.author}
                  createdAt={Math.floor(m.ms / 1000)}
                  continuation={continuation}
                  actions={
                    user ? (
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          aria-label="React 👍"
                          onClick={() => handleReact(m.messageId, "👍")}
                        >
                          👍
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          aria-label="Reply"
                          onClick={() => setReplyTo({ id: m.messageId, author: m.author })}
                        >
                          <Reply className="size-3.5" />
                        </Button>
                      </div>
                    ) : undefined
                  }
                  beforeBody={
                    replyTarget ? (
                      <div className="text-xs text-muted-foreground/70 mb-0.5 truncate">
                        ↩ replying to {replyTarget.slice(0, 8)}…
                      </div>
                    ) : undefined
                  }
                  afterBody={
                    tallies && tallies.size > 0 ? (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {[...tallies.entries()].map(([emoji, reactors]) => {
                          const mine = Boolean(user && reactors.has(user.pubkey));
                          return (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => handleReact(m.messageId, emoji)}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                                mine ? "border-primary/50 bg-primary/10" : "border-border",
                              )}
                            >
                              <span>{emoji}</span>
                              <span className="tabular-nums text-muted-foreground">{reactors.size}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : undefined
                  }
                >
                  <ChatContent event={event} className="text-[15px]" />
                </MessageRow>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground">No messages yet. Say something — only members can read it.</p>
          )}
            </div>

            {replyTo && (
              <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground border-t border-border/50">
                <Reply className="size-3.5" />
                <span className="flex-1 truncate">Replying to {replyTo.author.slice(0, 8)}…</span>
                <Button variant="ghost" size="icon" className="size-5" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>
                  <X className="size-3.5" />
                </Button>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="flex items-center gap-2 px-4 py-3"
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={user ? "Message (encrypted)…" : "Sign in to send"}
                disabled={!user || !channel}
                autoComplete="off"
              />
              <Button type="submit" size="icon" disabled={!user || !channel || sending || !draft.trim()}>
                {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </Button>
            </form>
          </div>

          {/* Member panel: width-animated on desktop, slide overlay on mobile. */}
          <div
            className={cn(
              "overflow-hidden",
              "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
              "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
              membersVisible ? "" : "pointer-events-none sidebar:pointer-events-auto",
              membersVisible && "sidebar:w-[16.5rem]",
            )}
          >
            <div
              className={cn(
                "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
                membersVisible ? "opacity-100" : "opacity-0",
              )}
            />
            <div
              className={cn(
                "relative h-full flex w-full sidebar:w-[16.5rem] transition-transform duration-200 ease-out",
                membersVisible ? "translate-x-0 sidebar:translate-x-0" : "translate-x-full sidebar:translate-x-full",
              )}
            >
              <MemberList
                admins={memberAdmins}
                members={memberPubkeys}
                canModerate={iAmOwner}
                viewerIsAdmin={iAmOwner}
                currentUserPubkey={user?.pubkey}
                onSetRole={iAmOwner ? handleSetRole : undefined}
                onClose={() => setMembersVisible(false)}
              />
            </div>
          </div>
        </div>
      </main>

      <InviteConcordDialog community={community} open={inviteOpen} onOpenChange={setInviteOpen} />
    </>
  );
}

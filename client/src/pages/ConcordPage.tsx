import { bytesToHex } from "@noble/hashes/utils.js";
import { Hash, Headphones, Loader2, LogOut, Menu, MoreVertical, Phone, Plus, Reply, ShieldCheck, UserPlus, Users, Volume2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { MemberList } from "@/components/chat/MemberList";
import { MessageTimeline } from "@/components/chat/MessageTimeline";
import { VoicePresence } from "@/components/VoicePresence";
import { InviteConcordDialog } from "@/components/dialogs/InviteConcordDialog";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useConcordActions } from "@/hooks/useConcordActions";
import { useConcordCommunity } from "@/hooks/useConcordList";
import { useConcordCommunityActions } from "@/hooks/useConcordCommunityActions";
import { useConcordRosterActions, concordMembers } from "@/hooks/useConcordRoster";
import { useConcordTransport } from "@/hooks/useConcordTransport";
import { useConcordVoiceServer } from "@/hooks/useConcordVoice";
import { useConcordVoicePresence } from "@/hooks/useConcordVoice";
import { useSendConcordMessage } from "@/hooks/useConcordChannel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { isAdmin as rosterIsAdmin } from "@/lib/concord/roles";
import type { Channel, Community } from "@/lib/concord/types";
import { cn } from "@/lib/utils";

import type { ChatMsg } from "@/components/chat/transport";

/** Compact "replying to" context line shown above a Concord reply message. */
function ConcordReplyContext({ pubkey }: { pubkey: string | undefined }) {
  const author = useAuthor(pubkey);
  const displayName = useScopedDisplayName(pubkey, author.data?.metadata);
  if (!pubkey) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80 mb-0.5 min-w-0">
      <Reply className="size-3 shrink-0" />
      <span className="font-semibold shrink-0">{displayName}</span>
    </div>
  );
}

/** The reply target id for a Concord message (NIP-10 marked reply e-tag). */
function replyTargetId(event: ChatMsg): string | undefined {
  return event.tags.find((t) => t[0] === "e" && t[3] === "reply")?.[1];
}

/**
 * A channel row in the Concord sidebar. Shows a voice presence stack + a
 * Volume2 icon when members are in this channel's voice room (live kind-3306),
 * mirroring the NIP-29 channel list.
 */
function ConcordChannelRow({
  community,
  channel,
  active,
  onSelect,
}: {
  community: Community;
  channel: Channel;
  active: boolean;
  onSelect: () => void;
}) {
  const { data: presence } = useConcordVoicePresence(community, channel);
  const pubkeys = (presence ?? []).map((p) => p.pubkey);
  const inVoice = pubkeys.length > 0;
  const Icon = inVoice ? Volume2 : Hash;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 pl-4 pr-2 py-1.5 text-sm transition-colors text-left",
        "text-muted-foreground hover:text-foreground",
        active && "text-foreground font-medium",
      )}
    >
      <Icon className={cn("size-4 shrink-0", inVoice && "text-success")} />
      <span className="truncate flex-1 min-w-0">{channel.name}</span>
      {inVoice && <VoicePresence participants={pubkeys} max={2} className="text-[0px]" />}
    </button>
  );
}

/**
 * A Concord (end-to-end-encrypted) community: its channels + sealed chat. Lives
 * at `/c/:communityId`, rehydrated from the encrypted membership list. No host
 * reads these messages — they're decrypted client-side from opaque relay blobs.
 *
 * Renders through the SAME shared chat components as NIP-29 group chat
 * (`MessageTimeline` + `ChatMessage` + `ChatComposer`), driven by a Concord
 * `ChatTransport`; only the transport (sealed envelopes vs. relay kind-9) and
 * the channel/community chrome differ.
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

  const { roster, setAdmin } = useConcordRosterActions(community);
  const ownerHex = roster?.ownerHex;
  const iAmOwner = Boolean(user && ownerHex && user.pubkey === ownerHex);
  const canWrite = Boolean(user && channel);

  const { transport, reactionsFor } = useConcordTransport(community, channel, canWrite, iAmOwner);
  const { mutateAsync: send } = useSendConcordMessage(community, channel);
  const { createChannel, isAddingChannel } = useConcordActions();
  const { leave, isLeaving } = useConcordCommunityActions(community);
  const { joinConcordCall, activeCall } = useCall();
  const { data: voiceServer } = useConcordVoiceServer(community, channel);
  const hasVoice = Boolean(voiceServer);
  const { data: voicePresence } = useConcordVoicePresence(community, channel);
  const voicePubkeys = useMemo(() => (voicePresence ?? []).map((p) => p.pubkey), [voicePresence]);
  const inThisVoice = Boolean(
    activeCall?.concord && channel && bytesToHex(activeCall.concord.channel.id) === bytesToHex(channel.id),
  );
  const navigateTo = useNavigate();
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  /** Desktop: whether the member roster pane is shown. */
  const [membersVisible, setMembersVisible] = useState(true);
  /** Mobile: whether the member sheet is open. */
  const [membersOpen, setMembersOpen] = useState(false);
  /** Mobile: whether the channel-list drawer is open. */
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMsg | undefined>(undefined);

  // Adapt the folded Concord roster to the shared MemberList's props. The
  // control-plane roster only enumerates the owner + members granted a role —
  // ordinary key-holders aren't individually listed (by design). So union it
  // with everyone who's actually authored a message in this community's loaded
  // channels: a participant who posted is provably a member, even without a
  // role grant. (Mirrors how the NIP-29 composer scopes mentions to people who
  // have spoken in the room.)
  const memberAdmins = useMemo(
    () =>
      roster
        ? concordMembers(roster)
            .map((m) => m.pubkey)
            .filter((pk) => pk === ownerHex || rosterIsAdmin(roster.roster, pk))
            .map((pubkey) => ({ pubkey, roles: ["admin"] }))
        : [],
    [roster, ownerHex],
  );
  const memberPubkeys = useMemo(() => {
    const set = new Set<string>();
    if (roster) for (const m of concordMembers(roster)) set.add(m.pubkey);
    for (const m of transport.messages) set.add(m.pubkey);
    if (user) set.add(user.pubkey);
    return [...set];
  }, [roster, transport.messages, user]);

  if (!communityId) return <Navigate to="/" replace />;

  // Send via the rich composer: the whole content is sealed; the reply target
  // (if any) rides along as an `e` reference on the inner event.
  const handleSend = async (content: string) => {
    const reference = replyTo?.id;
    setReplyTo(undefined);
    await send({ content, reference });
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

  const handleLeave = async () => {
    try {
      await leave();
      navigateTo("/");
    } catch {
      // best-effort
    }
  };

  const handleJoinVoice = () => {
    if (!community || !channel || !voiceServer) return;
    joinConcordCall({ community, channel, voiceServer });
  };

  /** Map the shared MemberList's role-string action onto Concord's grant model. */
  const handleSetRole = (pubkey: string, roles: string[]) => {
    setAdmin({ member: pubkey, admin: roles.includes("admin") }).catch(() => {});
  };

  // The channel-list body, shared verbatim by the desktop sidebar and the
  // mobile drawer (so the two never drift — same chrome, same rows).
  const channelList = (onNavigate?: () => void) => (
    <ChannelSidebarView
      className={onNavigate ? "flex-1" : "hidden sidebar:flex"}
      title={community?.name ?? "…"}
      titleIcon={<ShieldCheck className="size-4 text-success shrink-0" />}
      subtitle={<span className="text-success/80">End-to-end encrypted</span>}
      addChannelLabel={user && community ? "Add channel" : undefined}
      onAddChannel={user && community ? () => setCreatingChannel((v) => !v) : undefined}
      channelsHeaderExtra={
        creatingChannel ? (
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
        ) : undefined
      }
    >
      {!community ? (
        <div className="space-y-2 px-2 py-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : (
        community.channels.map((c) => {
          const idHex = bytesToHex(c.id);
          const active = Boolean(channel && bytesToHex(channel.id) === idHex);
          return (
            <ConcordChannelRow
              key={idHex}
              community={community}
              channel={c}
              active={active}
              onSelect={() => {
                setChannelIdHex(idHex);
                onNavigate?.();
              }}
            />
          );
        })
      )}
    </ChannelSidebarView>
  );

  return (
    <>
      {/* Desktop panes (hidden on mobile — the chat is the full screen). */}
      <ServerRail className="hidden sidebar:flex" />
      {channelList()}

      {/* Chat */}
      <main className="flex-1 min-w-0 flex flex-col safe-area-top">
        <header className="relative h-12 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
          {/* Mobile menu → reveals the channel list as a left drawer. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open channels"
            className="size-9 shrink-0 sidebar:hidden"
            onClick={() => setChannelsOpen(true)}
          >
            <Menu className="size-5" />
          </Button>

          <Hash className="size-5 text-muted-foreground shrink-0" />
          <h1 className="font-semibold truncate leading-tight">{channel?.name ?? "…"}</h1>
          <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-success">
            <ShieldCheck className="size-3" /> Encrypted
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {hasVoice && voicePubkeys.length > 0 && (
              <VoicePresence participants={voicePubkeys} className="mr-1" />
            )}
            {user && hasVoice && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-8", inThisVoice && "text-success")}
                    aria-label={inThisVoice ? "In voice" : "Join encrypted voice"}
                    disabled={inThisVoice}
                    onClick={handleJoinVoice}
                  >
                    {inThisVoice ? <Headphones className="size-4" /> : <Phone className="size-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{inThisVoice ? "In voice" : "Join encrypted voice"}</TooltipContent>
              </Tooltip>
            )}
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
            {/* Mobile members button → opens the member sheet. */}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Members"
              aria-pressed={membersOpen}
              className="size-8 sidebar:hidden"
              onClick={() => setMembersOpen((v) => !v)}
            >
              <Users className="size-4" />
            </Button>
            {/* Desktop members toggle → shows/hides the roster panel. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "size-8 hidden sidebar:inline-flex text-muted-foreground",
                    membersVisible && "text-foreground",
                  )}
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

        {/* Chat + members. Member panel mirrors the NIP-29 GroupPage. */}
        <div className="relative flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 flex flex-col">
            <MessageTimeline
              transport={transport}
              className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4"
              emptyState={
                <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                  No messages yet. Say something — only members can read it.
                </p>
              }
              renderMessage={(msg, continuation) => {
                const replyPk = replyTargetId(msg)
                  ? transport.messages.find((m) => m.id === replyTargetId(msg))?.pubkey
                  : undefined;
                return (
                  <ChatMessage
                    key={msg.id}
                    event={msg}
                    canWrite={transport.canWrite}
                    canModerate={transport.canModerate}
                    reactions={reactionsFor(msg.id)}
                    continuation={continuation}
                    replyContext={<ConcordReplyContext pubkey={replyPk} />}
                    onReply={canWrite ? setReplyTo : undefined}
                    onDelete={transport.deleteMessage}
                  />
                );
              }}
            />

            {channel && (
              <ChatComposer
                relayUrl="dm"
                groupId={channel ? bytesToHex(channel.id) : "concord"}
                messages={[]}
                replyTo={replyTo}
                onCancelReply={() => setReplyTo(undefined)}
                placeholder={user ? "Message (encrypted)…" : "Sign in to send"}
                sendOverride={handleSend}
              />
            )}
          </div>

          {/* Member panel: width-animated on desktop, slide overlay on mobile.
              Mirrors the NIP-29 GroupPage member panel. */}
          <div
            className={cn(
              "overflow-hidden",
              "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
              "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
              membersOpen ? "" : "pointer-events-none sidebar:pointer-events-auto",
              membersVisible && "sidebar:w-[16.5rem]",
            )}
          >
            {/* Mobile backdrop: fades in/out in sync with the panel slide. */}
            <div
              className={cn(
                "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
                membersOpen ? "opacity-100" : "opacity-0",
              )}
            />
            <div
              className={cn(
                "relative h-full flex w-full sidebar:w-[16.5rem] transition-transform duration-200 ease-out",
                // Mobile: driven by membersOpen. Desktop: driven by membersVisible.
                membersOpen ? "translate-x-0" : "translate-x-full",
                membersVisible ? "sidebar:translate-x-0" : "sidebar:translate-x-full",
              )}
            >
              <MemberList
                admins={memberAdmins}
                members={memberPubkeys}
                canModerate={iAmOwner}
                viewerIsAdmin={iAmOwner}
                currentUserPubkey={user?.pubkey}
                onSetRole={iAmOwner ? handleSetRole : undefined}
                onClose={() => setMembersOpen(false)}
              />
            </div>
          </div>
        </div>
      </main>

      {/* Mobile channel list drawer (server rail + channels) */}
      <Sheet open={channelsOpen} onOpenChange={setChannelsOpen}>
        <SheetContent
          side="left"
          className="flex w-[min(20rem,85vw)] gap-0 p-0 sidebar:hidden [&>button]:hidden"
          aria-label="Channels"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex h-full w-full safe-area-top">
            <ServerRail onNavigate={() => setChannelsOpen(false)} />
            {channelList(() => setChannelsOpen(false))}
          </div>
        </SheetContent>
      </Sheet>

      <InviteConcordDialog community={community} open={inviteOpen} onOpenChange={setInviteOpen} />
    </>
  );
}

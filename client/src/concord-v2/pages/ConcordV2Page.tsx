import { ChevronLeft, Hash, Loader2, Lock, LogOut, MoreVertical, Plus, Settings, Shield, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage, ReplyContextLine, replyPreviewText } from "@/components/chat/ChatMessage";
import { LoginArea } from "@/components/auth/LoginArea";
import { MemberList } from "@/components/chat/MemberList";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import { InviteDialog2 } from "@/concord-v2/components/InviteDialog2";
import { RolesDialog2 } from "@/concord-v2/components/RolesDialog2";
import { SettingsDialog2 } from "@/concord-v2/components/SettingsDialog2";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
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
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { useCommunity2 } from "@/concord-v2/hooks/useCommunityList2";
import { useCommunityManagement2 } from "@/concord-v2/hooks/useCommunityActions2";
import { useChannels2, useControlFold2, useDissolved2 } from "@/concord-v2/hooks/useControlPlane2";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import { useGuestbook2 } from "@/concord-v2/hooks/useGuestbook2";
import { useModeration2 } from "@/concord-v2/hooks/useModeration2";
import { useRekeyWatch2 } from "@/concord-v2/hooks/useRekey2";
import { useRoles2 } from "@/concord-v2/hooks/useRoles2";
import { useSendMessage2 } from "@/concord-v2/hooks/useChannel2";
import { useTransport2 } from "@/concord-v2/hooks/useTransport2";
import { useTyping2, useTypingPublisher2 } from "@/concord-v2/hooks/useTyping2";
import { useRegisterChannelStreamKeys2 } from "@/concord-v2/hooks/useStreamAuth2";
import { isAdmin as rosterIsAdmin, isAuthorized, Permissions } from "@/concord-v2/lib/roles";
import type { ChannelV2, CommunityV2, ImagePointer } from "@/concord-v2/lib/types";
import { cn, pickDefaultChannel } from "@/lib/utils";

import type { ChatMsg, MessageReactions, SendStatus } from "@/components/chat/transport";

/** V2 replies quote their parent with a `q` tag (NIP-C7). */
function getReplyToId2(msg: ChatMsg): string | undefined {
  return msg.tags.find((t) => t[0] === "q")?.[1];
}

/** Reply context resolved from already-decoded history (relays can't serve sealed targets). */
function ReplyContext2({
  pubkey,
  preview,
  onClick,
}: {
  pubkey: string | undefined;
  preview: string | undefined;
  onClick: (() => void) | undefined;
}) {
  const author = useAuthor(pubkey);
  const displayName = useScopedDisplayName(pubkey, author.data?.metadata);
  if (!pubkey) return null;
  return <ReplyContextLine name={displayName} preview={preview} onClick={onClick} />;
}

function TypingName({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  return <span className="font-medium not-italic">{useScopedDisplayName(pubkey, author.data?.metadata)}</span>;
}

function TypingIndicator2({ pubkeys }: { pubkeys: string[] }) {
  if (pubkeys.length === 0) return null;
  if (pubkeys.length > 3) {
    return <div className="px-4 pb-0.5 text-xs italic text-muted-foreground">Several people are typing…</div>;
  }
  const names = pubkeys.map((pk) => <TypingName key={pk} pubkey={pk} />);
  return (
    <div className="px-4 pb-0.5 text-xs italic text-muted-foreground">
      {names.map((name, i) => (
        <span key={pubkeys[i]}>
          {name}
          {i < names.length - 2 ? ", " : i === names.length - 2 ? (names.length > 2 ? ", and " : " and ") : ""}
        </span>
      ))}
      {names.length === 1 ? " is typing…" : " are typing…"}
    </div>
  );
}

/** The community's decrypted icon for the channel-list title (shield accent = E2E trust). */
function TitleIcon2({ icon }: { icon: ImagePointer | undefined }) {
  const url = useDecryptedImage2(icon);
  if (!url) return <ShieldCheck className="size-4 text-success shrink-0" />;
  return (
    <span className="relative shrink-0">
      <img src={url} alt="" className="size-5 rounded object-cover" />
      <ShieldCheck className="absolute -bottom-1 -right-1 size-2.5 text-success" />
    </span>
  );
}

function Banner2({ banner }: { banner: ImagePointer | undefined }) {
  const url = useDecryptedImage2(banner);
  if (!url) return null;
  return (
    <div className="h-20 w-full shrink-0 overflow-hidden">
      <img src={url} alt="" className="size-full object-cover" />
    </div>
  );
}

interface ChatMessage2Props {
  event: ChatMsg;
  reactions: MessageReactions;
  replyPubkey: string | undefined;
  replyPreview: string | undefined;
  replyId: string | undefined;
  continuation: boolean;
  canWrite: boolean;
  canModerate: boolean;
  sendStatus: SendStatus | undefined;
  active: boolean;
  onToggleActive: (id: string) => void;
  onReply: ((event: ChatMsg) => void) | undefined;
  onDelete: ((event: ChatMsg) => void) | undefined;
  onRetry: ((event: ChatMsg) => void) | undefined;
  onDiscard: ((id: string) => void) | undefined;
  onJumpToReply: (id: string) => void;
}

/** Memoized per-message binding (mirrors V1's ConcordChatMessage). */
const ChatMessage2 = memo(function ChatMessage2({
  event,
  reactions,
  replyPubkey,
  replyPreview,
  replyId,
  continuation,
  canWrite,
  canModerate,
  sendStatus,
  active,
  onToggleActive,
  onReply,
  onDelete,
  onRetry,
  onDiscard,
  onJumpToReply,
}: ChatMessage2Props) {
  return (
    <ChatMessage
      event={event}
      canWrite={canWrite}
      canModerate={canModerate}
      reactions={reactions}
      sendStatus={sendStatus}
      continuation={continuation}
      active={active}
      onToggleActive={onToggleActive}
      replyContext={
        <ReplyContext2
          pubkey={replyPubkey}
          preview={replyPreview}
          onClick={replyId ? () => onJumpToReply(replyId) : undefined}
        />
      }
      onReply={onReply}
      onDelete={onDelete}
      onRetry={onRetry ? () => onRetry(event) : undefined}
      onDiscard={onDiscard ? () => onDiscard(event.id) : undefined}
    />
  );
});

/** The pinned footer for the V2 channel sidebar (account area). */
function SidebarFooter2() {
  return (
    <div className="px-3 pb-safe shrink-0">
      <LoginArea className="w-full flex" />
    </div>
  );
}

function ChannelRow2({
  channel,
  active,
  onSelect,
}: {
  channel: ChannelV2;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = channel.isPrivate ? Lock : Hash;
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
      <Icon className="size-4 shrink-0" />
      <span className="truncate flex-1 min-w-0">{channel.name}</span>
    </button>
  );
}

/**
 * A Concord V2 community — CORD-01..06 Private Streams over interchangeable
 * relays, no host, no `#z` tags: every plane is kind-1059 traffic at derived
 * stream addresses. Lives at `/c/:communityId`, rehydrated from the
 * self-encrypted Community List. Renders through the SAME shared chat
 * components as NIP-29 / DMs / Concord V1; only the transport differs.
 */
export function ConcordV2Page() {
  const { communityId, channelId: routeChannelId } = useParams<{ communityId: string; channelId: string }>();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const lastChannelKey = communityId ? `c2:${communityId}` : "";

  const baseCommunity = useCommunity2(communityId);
  const { data: folded } = useControlFold2(baseCommunity);
  // Overlay the folded, owner-controlled metadata onto the bundle preview.
  const community = useMemo<CommunityV2 | undefined>(() => {
    if (!baseCommunity) return undefined;
    if (!folded?.metadata) return baseCommunity;
    return { ...baseCommunity, name: folded.metadata.name || baseCommunity.name };
  }, [baseCommunity, folded]);
  const channels = useChannels2(baseCommunity);

  // Authenticate the connection as this community's per-channel stream keys
  // (control/guestbook/dissolved keys are registered app-wide in MainLayout).
  useRegisterChannelStreamKeys2(communityId);

  // React to base-rekey rotations (adopt the new epoch, or discover removal).
  useRekeyWatch2(baseCommunity);

  const [channelIdHex, setChannelIdHex] = useState<string | null>(routeChannelId ?? null);
  useEffect(() => {
    if (routeChannelId) setChannelIdHex(routeChannelId);
  }, [routeChannelId]);

  const channel = useMemo(() => {
    if (channels.length === 0) return undefined;
    if (channelIdHex) return channels.find((c) => c.idHex === channelIdHex) ?? channels[0];
    return pickDefaultChannel(
      channels,
      config.lastChannelByServer[lastChannelKey],
      (c) => c.idHex,
      (c) => c.name,
    );
  }, [channels, channelIdHex, config.lastChannelByServer, lastChannelKey]);

  useEffect(() => {
    if (!lastChannelKey || !channel) return;
    updateConfig((c) =>
      c.lastChannelByServer[lastChannelKey] === channel.idHex
        ? c
        : { ...c, lastChannelByServer: { ...c.lastChannelByServer, [lastChannelKey]: channel.idHex } },
    );
  }, [channel, lastChannelKey, updateConfig]);

  const { setAdmin } = useRoles2(community);
  const ownerHex = folded?.ownerHex ?? community?.owner;
  const iAmOwner = Boolean(user && ownerHex && user.pubkey === ownerHex);
  const roster = folded?.roster;
  const canManageRoles = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_ROLES));
  const canManageMetadata = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_METADATA));
  const canManageChannels = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS));
  const canKickAny = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.KICK));
  const canBanAny = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.BAN));
  const canModerateMessages = Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, ownerHex, Permissions.MANAGE_MESSAGES));
  const canWrite = Boolean(user && channel);

  const { transport, reactionsFor, allMessages } = useTransport2(community, channel, canWrite, canModerateMessages);
  const { mutateAsync: send } = useSendMessage2(community, channel);
  const { leave, isLeaving, dissolve, createChannel, isAddingChannel } = useCommunityManagement2(community);
  const { data: dissolved } = useDissolved2(community);
  const { coalesced } = useGuestbook2(community);

  const navigateTo = useNavigate();
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [membersVisible, setMembersVisible] = useState(true);
  const [membersOpen, setMembersOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMsg | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback((id: string) => setActiveId((cur) => (cur === id ? undefined : id)), []);

  // Member list: the coalesced Guestbook (joins) ∪ observed authors ∪ roster,
  // minus the banned — the Complete Memberlist (CORD-02 §5).
  const memberAdmins = useMemo(() => {
    const out: Array<{ pubkey: string; roles: string[] }> = [];
    if (ownerHex) out.push({ pubkey: ownerHex, roles: ["owner"] });
    if (roster) {
      for (const g of roster.grants) {
        if (g.member !== ownerHex && rosterIsAdmin(roster, g.member)) out.push({ pubkey: g.member, roles: ["admin"] });
      }
    }
    return out;
  }, [roster, ownerHex]);

  const memberPubkeys = useMemo(() => {
    const banned = folded?.banned ?? new Set<string>();
    const set = new Set<string>();
    for (const [pk, m] of coalesced) if (m.state === "join" && !banned.has(pk)) set.add(pk);
    for (const m of allMessages) if (!banned.has(m.pubkey)) set.add(m.pubkey);
    for (const g of roster?.grants ?? []) if (g.roleIds.length > 0 && !banned.has(g.member)) set.add(g.member);
    if (ownerHex) set.add(ownerHex);
    if (user) set.add(user.pubkey);
    return [...set];
  }, [coalesced, allMessages, roster, ownerHex, user, folded]);

  const pubkeyById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of allMessages) map.set(m.id, m.pubkey);
    return map;
  }, [allMessages]);

  const previewById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of allMessages) map.set(m.id, replyPreviewText(m.content));
    return map;
  }, [allMessages]);

  const onReplyCb = useMemo(() => (canWrite ? setReplyTo : undefined), [canWrite]);

  const timelineRef = useRef<MessageTimelineHandle | null>(null);
  const jumpToReply = useCallback((id: string) => {
    timelineRef.current?.scrollToMessage(id);
  }, []);

  const moderation = useModeration2(community, memberPubkeys);

  const publishTyping = useTypingPublisher2(community, channel);
  const typingPubkeys = useTyping2(community, channel);

  // A dissolved community is terminal — read-only would be ideal; for now
  // navigate home (the list entry stays until the user leaves).
  useEffect(() => {
    if (dissolved) navigateTo("/");
  }, [dissolved, navigateTo]);

  if (!communityId) return <Navigate to="/" replace />;

  const handleSend = async (content: string, tags: string[][]) => {
    const parent = replyTo;
    setReplyTo(undefined);
    // The composer's content-derived tags (emoji, imeta, mentions) are sealed
    // verbatim; NIP-29 `h` and NIP-10 `e` reply tags are dropped (the reply is
    // the rumor's own `q`).
    const extraTags = tags.filter(([name]) => name !== "h" && name !== "e" && name !== "q");
    await send({
      content,
      replyTo: parent ? { id: parent.id, author: parent.pubkey } : undefined,
      extraTags,
    });
  };

  const handleCreateChannel = async () => {
    const name = newChannelName.trim();
    if (!name || !community) return;
    try {
      const { channelIdHex: created } = await createChannel({ name });
      setChannelIdHex(created);
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

  const handleDissolve = async () => {
    if (!confirm("Permanently delete this community for everyone? This cannot be undone.")) return;
    try {
      await dissolve();
      toast({ title: "Community deleted" });
      navigateTo("/");
    } catch (e) {
      toast({ title: "Couldn't delete", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const handleSetRole = (pubkey: string, roles: string[]) => {
    setAdmin({ member: pubkey, admin: roles.includes("admin") }).catch(() => {});
  };

  const handleBan = async (pubkey: string) => {
    try {
      const { rekeyed } = await moderation.ban({ target: pubkey });
      if (rekeyed) {
        toast({ title: "Member banned", description: "Keys rotated; they can no longer read new messages." });
      } else {
        toast({ title: "Member banned", description: "Added to the banlist; key rotation didn't complete (you can retry)." });
      }
    } catch (e) {
      toast({ title: "Couldn't ban", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const channelList = (onNavigate?: () => void, className?: string) => (
    <ChannelSidebarView
      className={className ?? (onNavigate ? "flex-1" : "hidden sidebar:flex")}
      title={community?.name ?? "…"}
      titleIcon={<TitleIcon2 icon={folded?.metadata?.icon} />}
      banner={<Banner2 banner={folded?.metadata?.banner} />}
      addChannelLabel={user && community && canManageChannels ? "Add channel" : undefined}
      onAddChannel={user && community && canManageChannels ? () => setCreatingChannel((v) => !v) : undefined}
      footer={<SidebarFooter2 />}
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
      {!community || channels.length === 0 ? (
        <div className="space-y-2 px-2 py-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : (
        channels.map((c) => (
          <ChannelRow2
            key={c.idHex}
            channel={c}
            active={Boolean(channel && channel.idHex === c.idHex)}
            onSelect={() => {
              setChannelIdHex(c.idHex);
              onNavigate?.();
            }}
          />
        ))
      )}
    </ChannelSidebarView>
  );

  return (
    <>
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            <ServerRail onNavigate={() => setChannelsOpen(false)} />
            {channelList(() => setChannelsOpen(false), "flex-1 sidebar:flex-none")}
          </>
        }
      >
        <main className="flex-1 min-w-0 flex flex-col safe-area-top h-full">
          <header className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to channels"
              className="size-9 shrink-0 sidebar:hidden"
              onClick={() => setChannelsOpen(true)}
            >
              <ChevronLeft className="size-5" />
            </Button>

            {channel?.isPrivate ? (
              <Lock className="size-5 text-muted-foreground shrink-0" />
            ) : (
              <Hash className="size-5 text-muted-foreground shrink-0" />
            )}
            <h1 className="font-semibold truncate leading-tight">{channel?.name ?? "…"}</h1>
            <div className="ml-auto flex items-center gap-0.5">
              {user && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8 touch:size-10" aria-label="Invite people" onClick={() => setInviteOpen(true)}>
                      <UserPlus className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Invite people</TooltipContent>
                </Tooltip>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Members"
                aria-pressed={membersOpen}
                className="size-8 touch:size-10 sidebar:hidden"
                onClick={() => setMembersOpen((v) => !v)}
              >
                <Users className="size-4" />
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-8 hidden sidebar:inline-flex text-muted-foreground", membersVisible && "text-foreground")}
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
                    <Button variant="ghost" size="icon" className="size-8 touch:size-10" aria-label="Community actions">
                      <MoreVertical className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48 p-2">
                    {canManageRoles && (
                      <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={() => setRolesOpen(true)}>
                        <Shield className="size-4" />
                        Manage roles
                      </DropdownMenuItem>
                    )}
                    {canManageMetadata && (
                      <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={() => setSettingsOpen(true)}>
                        <Settings className="size-4" />
                        Community settings
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      className="gap-3 px-3 py-2.5 text-destructive focus:text-destructive"
                      disabled={isLeaving}
                      onClick={handleLeave}
                    >
                      <LogOut className="size-4" />
                      Leave community
                    </DropdownMenuItem>
                    {iAmOwner && (
                      <DropdownMenuItem className="gap-3 px-3 py-2.5 text-destructive focus:text-destructive" onClick={handleDissolve}>
                        <Trash2 className="size-4" />
                        Delete community
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </header>

          <div className="relative flex flex-1 min-h-0">
            <div className="flex-1 min-w-0 flex flex-col">
              <MessageTimeline
                key={channel?.idHex ?? "none"}
                transport={transport}
                handleRef={timelineRef}
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4"
                emptyState={
                  <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                    No messages yet. Say something — only members can read it.
                  </p>
                }
                renderMessage={(msg, continuation) => {
                  const replyId = getReplyToId2(msg);
                  const replyPk = replyId ? pubkeyById.get(replyId) ?? msg.tags.find((t) => t[0] === "q")?.[3] : undefined;
                  const replyPreview = replyId ? previewById.get(replyId) : undefined;
                  return (
                    <ChatMessage2
                      key={msg.id}
                      event={msg}
                      reactions={reactionsFor(msg.id)}
                      replyPubkey={replyPk}
                      replyPreview={replyPreview}
                      replyId={replyId}
                      continuation={continuation}
                      canWrite={transport.canWrite}
                      canModerate={transport.canModerate}
                      sendStatus={transport.sendStatusFor?.(msg.id)}
                      active={activeId === msg.id}
                      onToggleActive={toggleActive}
                      onReply={onReplyCb}
                      onDelete={transport.deleteMessage}
                      onRetry={transport.retry}
                      onDiscard={transport.discard}
                      onJumpToReply={jumpToReply}
                    />
                  );
                }}
              />

              {typingPubkeys.length > 0 && <TypingIndicator2 pubkeys={typingPubkeys} />}
              {channel && (
                <ChatComposer
                  relayUrl="dm"
                  groupId={channel.idHex}
                  messages={[]}
                  mentionPubkeys={memberPubkeys}
                  replyTo={replyTo}
                  onCancelReply={() => setReplyTo(undefined)}
                  placeholder={user ? `Message #${channel.name}` : "Sign in to send"}
                  sendOverride={handleSend}
                  onTyping={publishTyping}
                  encryptAttachments
                />
              )}
            </div>

            {/* Member panel: width-animated on desktop, slide overlay on mobile. */}
            <div
              className={cn(
                "overflow-hidden",
                "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
                "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
                membersOpen ? "" : "pointer-events-none sidebar:pointer-events-auto",
                membersVisible && "sidebar:w-[16.5rem]",
              )}
            >
              <div
                className={cn(
                  "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
                  membersOpen ? "opacity-100" : "opacity-0",
                )}
              />
              <div
                className={cn(
                  "relative h-full flex w-full sidebar:w-[16.5rem] transition-transform duration-200 ease-out",
                  membersOpen ? "translate-x-0" : "translate-x-full",
                  membersVisible ? "sidebar:translate-x-0" : "sidebar:translate-x-full",
                )}
              >
                <MemberList
                  admins={memberAdmins}
                  members={memberPubkeys}
                  canModerate={canManageRoles || canKickAny || canBanAny}
                  viewerIsAdmin={iAmOwner}
                  currentUserPubkey={user?.pubkey}
                  onSetRole={canManageRoles ? handleSetRole : undefined}
                  onKick={canKickAny ? (pk) => moderation.kick({ target: pk }).catch(() => {}) : undefined}
                  onBan={canBanAny ? handleBan : undefined}
                  onUnban={canBanAny ? (pk) => moderation.unban({ target: pk }).catch(() => {}) : undefined}
                  bannedPubkeys={moderation.banned}
                  onClose={() => setMembersOpen(false)}
                />
              </div>
            </div>
          </div>
        </main>
      </SwipeReveal>

      <InviteDialog2 community={community} open={inviteOpen} onOpenChange={setInviteOpen} />
      <SettingsDialog2 community={community} open={settingsOpen} onOpenChange={setSettingsOpen} />
      <RolesDialog2 community={community} open={rolesOpen} onOpenChange={setRolesOpen} />
    </>
  );
}

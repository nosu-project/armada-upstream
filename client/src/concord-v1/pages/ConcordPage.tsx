import { bytesToHex } from "@noble/hashes/utils.js";
import { ChevronLeft, Bell, BellOff, Hash, Loader2, LogOut, MoreVertical, Plus, Settings, Shield, Trash2, UserPlus, Users } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { AppStageSlot } from "@/components/chat/AppStage";import { ChannelNavContext } from "@/contexts/ChannelNavContext";
import { ChatScopeContext } from "@/contexts/ChatScopeContext";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { LoginArea } from "@/components/auth/LoginArea";
import { JoinButton } from "@/components/auth/JoinButton";
import { MemberList } from "@/components/chat/MemberList";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { InviteConcordDialog } from "@/concord-v1/components/InviteConcordDialog";
import { useConcord1Unread, type Concord1Unread } from "@/concord-v1/hooks/useConcord1Unread";
import { ConcordSettingsDialog } from "@/concord-v1/components/ConcordSettingsDialog";
import { ConcordRolesDialog } from "@/concord-v1/components/ConcordRolesDialog";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import { useCall } from "@/hooks/useCall";
import { useChannelNavValue } from "@/hooks/useChannelNav";
import { useConcordActions } from "@/concord-v1/hooks/useConcordActions";
import { useConcordCommunity } from "@/concord-v1/hooks/useConcordList";
import { useConcordCommunityActions } from "@/concord-v1/hooks/useConcordCommunityActions";
import { useConcordMetadata } from "@/concord-v1/hooks/useConcordMetadata";
import { useCommunityImageDescriptors } from "@/concord-v1/hooks/useCommunityImageDescriptors";
import { useConcordModeration } from "@/concord-v1/hooks/useConcordModeration";
import { useConcordTyping, useConcordTypingPublisher } from "@/concord-v1/hooks/useConcordTyping";
import { useConcordRosterActions, concordMembers } from "@/concord-v1/hooks/useConcordRoster";
import { useConcordDissolved } from "@/concord-v1/hooks/useConcordRoster";
import { useConcordTransport } from "@/concord-v1/hooks/useConcordTransport";
import { useSendConcordMessage } from "@/concord-v1/hooks/useConcordChannel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useDecryptedCommunityImage } from "@/concord-v1/hooks/useDecryptedCommunityImage";
import { concordChannelMuteKey, useMutes } from "@/hooks/useMutes";
import { toast } from "@/hooks/useToast";
import { isAdmin as rosterIsAdmin, isAuthorized, Permissions } from "@/concord-v1/lib/roles";
import { type Channel, type Community, type CommunityImage } from "@/concord-v1/lib/types";
import { cn, pickDefaultChannel } from "@/lib/utils";

import { threadSummary } from "@/components/chat/transport";
import type { ChatMsg, MessageReactions, SendStatus } from "@/components/chat/transport";

/** Stable empty replies array so a thread-less row keeps a constant prop. */
const EMPTY_REPLIES: ChatMsg[] = [];

/** The community's decrypted GroupRoot logo for the channel-list title. Renders
 *  nothing when the community has no icon (the header falls back to a
 *  name-only layout). */
function CommunityTitleIcon({ icon }: { icon: CommunityImage | undefined }) {
  const url = useDecryptedCommunityImage(icon);
  if (!url) return null;
  return <img src={url} alt="" className="size-5 rounded object-cover shrink-0" />;
}

/** The community's decrypted GroupRoot banner above the channel-list header.
 *  Renders nothing until decrypted (no layout shift / placeholder box). */
function CommunityBanner({ banner }: { banner: CommunityImage | undefined }) {
  const url = useDecryptedCommunityImage(banner);
  if (!url) return null;
  return (
    <div className="size-full overflow-hidden">
      <img src={url} alt="" className="size-full object-cover" />
    </div>
  );
}

interface ConcordChatMessageProps {
  event: ChatMsg;
  reactions: MessageReactions;
  /** This message's thread replies (stable ref from the transport), for the badge. */
  replies: ChatMsg[];
  continuation: boolean;
  canWrite: boolean;
  canModerate: boolean;
  sendStatus: SendStatus | undefined;
  /** Whether this row's tap-to-reveal toolbar is open (touch only). */
  active: boolean;
  /** Toggle this row's tap-to-reveal toolbar (touch only). */
  onToggleActive: (id: string) => void;
  onOpenThread: ((event: ChatMsg) => void) | undefined;
  onDelete: ((event: ChatMsg) => void) | undefined;
  onRetry: ((event: ChatMsg) => void) | undefined;
  onDiscard: ((id: string) => void) | undefined;
}

/**
 * Memoized per-message binding for Concord, mirroring NIP-29's
 * `Nip29ChatMessage`. It takes only individually-stable props (never the whole
 * `transport`, whose identity changes every poll), so when the page re-renders
 * (e.g. a reaction lands on another message, or the channel polls),
 * `React.memo` skips every row whose inputs are unchanged — the expensive
 * content tokenization, emoji maps and author queries don't re-run across the
 * whole room. Replies are threaded (nested in the thread panel), so the reply
 * action opens the thread rather than inserting a top-level quote.
 */
const ConcordChatMessage = memo(function ConcordChatMessage({
  event,
  reactions,
  replies,
  continuation,
  canWrite,
  canModerate,
  sendStatus,
  active,
  onToggleActive,
  onOpenThread,
  onDelete,
  onRetry,
  onDiscard,
}: ConcordChatMessageProps) {
  const threadInfo = threadSummary(replies);
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
      replyCount={replies.length}
      threadParticipants={threadInfo.participants}
      lastReplyAt={threadInfo.lastReplyAt}
      onOpenThread={onOpenThread}
      onDelete={onDelete}
      onRetry={onRetry ? () => onRetry(event) : undefined}
      onDiscard={onDiscard ? () => onDiscard(event.id) : undefined}
    />
  );
});

/**
 * The pinned footer for the Concord channel sidebar: the persistent voice
 * call-bar slot (the call UI portals here) above the account area / account
 * switcher — mirroring the NIP-29 ChannelSidebar footer. Each rendered instance
 * (desktop pane + mobile drawer) registers its own call-bar slot.
 */
function ConcordSidebarFooter() {
  const { user } = useCurrentUser();
  const { registerCallBarSlot } = useCall();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return registerCallBarSlot(el);
  }, [registerCallBarSlot]);
  return (
    <>
      {/* Voice call bar slot — the persistent call UI portals here. */}
      <div ref={ref} className="empty:hidden shrink-0 px-2 pb-2" />
      {/* Account area / account switcher. */}
      <div className="px-3 pb-safe shrink-0">
        {user ? (
          <LoginArea className="w-full flex" />
        ) : (
          <div className="p-2 flex justify-center">
            <JoinButton className="w-full max-w-xs clip-corner-lg font-medium" />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * A channel row in the Concord sidebar, mirroring the NIP-29 channel list:
 * unread channels read brighter + bold, mentions get an "@" pill.
 */
function ConcordChannelRow({
  communityId,
  channel,
  active,
  unread,
  onSelect,
}: {
  communityId: string;
  channel: Channel;
  active: boolean;
  unread?: Concord1Unread;
  onSelect: () => void;
}) {
  const { isConcordChannelMuted, toggleConcordChannelMute } = useMutes();
  const channelIdHex = bytesToHex(channel.id);
  const muted = isConcordChannelMuted("c1", communityId, channelIdHex);
  const hasUnread = Boolean(unread);
  const hasMention = Boolean(unread?.mention);
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            // Slack-style selection: the active channel sits on a filled primary
            // rectangle with the house cut-corner chamfer (matches ChannelSidebar).
            "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 text-sm transition-colors text-left",
            !active && "text-muted-foreground hover:text-foreground hover:bg-foreground/5 clip-corner-lg",
            // Unread (but not selected) channels read brighter + bold (Slack).
            // Muted channels never bold — their unread is deliberately silent.
            !active && hasUnread && !muted && "text-foreground font-semibold",
            // Muted channels read dimmer (Discord-style).
            !active && muted && "opacity-60",
            active && "clip-corner-lg bg-primary text-primary-foreground font-medium",
          )}
        >
          <Hash className="size-4 shrink-0" />
          <span className="truncate flex-1 min-w-0">{channel.name}</span>
          {muted && <BellOff className="size-3 shrink-0 opacity-60" aria-label="Muted" />}
          {hasMention ? (
            <span
              className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none"
              aria-label="You were mentioned"
            >
              @
            </span>
          ) : null}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => toggleConcordChannelMute("c1", communityId, channelIdHex)}>
          {muted ? (
            <>
              <Bell className="mr-2 size-4" /> Unmute channel
            </>
          ) : (
            <>
              <BellOff className="mr-2 size-4" /> Mute channel
            </>
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A Concord (end-to-end-encrypted) community: its channels + sealed chat. Lives
 * at `/c1/:communityId`, rehydrated from the encrypted membership list. No host
 * reads these messages — they're decrypted client-side from opaque relay blobs.
 *
 * Renders through the SAME shared chat components as NIP-29 group chat
 * (`MessageTimeline` + `ChatMessage` + `ChatComposer`), driven by a Concord
 * `ChatTransport`; only the transport (sealed envelopes vs. relay kind-9) and
 * the channel/community chrome differ.
 */
export function ConcordPage() {
  const { communityId, channelId: routeChannelId } = useParams<{ communityId: string; channelId: string }>();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const { mutedChannels, isCommunityMuted, toggleCommunityMute, toggleConcordChannelMute } = useMutes();
  // Storage key for this community's last-opened channel (local preference).
  const lastChannelKey = communityId ? `c:${communityId}` : "";
  const baseCommunity = useConcordCommunity(communityId);
  // Overlay the folded GroupRoot/channel metadata (vsk=0/2) onto the community
  // rehydrated from the membership-list bundle, so name/description/icon/banner
  // and channel names reflect authoritative, owner-controlled edits — while keys
  // and relays stay sourced from the sealed bundle.
  const { data: folded } = useConcordMetadata(baseCommunity);
  // Resolve icon/banner descriptors with a synchronous, disk-backed fallback so
  // they paint on the first frame after reload instead of flickering through the
  // initials/shield fallback while the (async) folded metadata lands.
  const { icon: seededIcon, banner: seededBanner } = useCommunityImageDescriptors(baseCommunity, folded);
  const community = useMemo<Community | undefined>(() => {
    if (!baseCommunity) return undefined;
    if (!folded) {
      // Even before the fold lands, carry the last-known-good icon/banner so the
      // header/rail don't blank.
      return { ...baseCommunity, icon: seededIcon, banner: seededBanner };
    }
    const channelNames = folded.channelNames instanceof Map ? folded.channelNames : undefined;
    return {
      ...baseCommunity,
      name: folded.root?.name ?? baseCommunity.name,
      description: folded.root?.description ?? baseCommunity.description,
      icon: folded.root?.icon ?? seededIcon,
      banner: folded.root?.banner ?? seededBanner,
      channels: baseCommunity.channels.map((ch) => {
        const name = channelNames?.get(bytesToHex(ch.id));
        return name ? { ...ch, name } : ch;
      }),
    };
  }, [baseCommunity, folded, seededIcon, seededBanner]);
  // Only show channel skeletons if the community bundle is still missing AND has
  // been for long enough to warrant a placeholder — on a cache hit it resolves
  // within a frame or two, so an ungated skeleton flashes for a nanosecond
  // (reads as a glitch). Delay it so fast loads show nothing.
  const showChannelSkeleton = useDelayedFlag(!community);
  const [channelIdHex, setChannelIdHex] = useState<string | null>(routeChannelId ?? null);

  // A deep-link to a specific channel (e.g. tapping a notification, which routes
  // to /c1/<community>/<channel>) must open THAT channel, overriding the
  // last-opened-channel memory below — even if the page is already mounted on a
  // different channel of the same community. In-page channel clicks use local
  // state and don't touch the URL, so this only fires on a genuine route change.
  useEffect(() => {
    if (routeChannelId) setChannelIdHex(routeChannelId);
  }, [routeChannelId]);

  const channel = useMemo(() => {
    if (!community) return undefined;
    // Explicit selection wins; otherwise open the last-used channel for this
    // community (Discord-style), falling back to "general" or the first.
    if (channelIdHex) {
      return (
        community.channels.find((c) => bytesToHex(c.id) === channelIdHex) ??
        community.channels[0]
      );
    }
    return pickDefaultChannel(
      community.channels,
      config.lastChannelByServer[lastChannelKey],
      (c) => bytesToHex(c.id),
      (c) => c.name,
    );
  }, [community, channelIdHex, config.lastChannelByServer, lastChannelKey]);

  // Individual mute states for the ⋮ menu. Like GroupPage, the side-by-side
  // "Mute channel" / "Mute community" items each reflect only their own scope
  // (no cascade), so a muted community doesn't flip the channel item.
  const currentChannelIdHex = channel ? bytesToHex(channel.id) : undefined;
  const channelMuted = Boolean(
    communityId && currentChannelIdHex &&
    mutedChannels.has(concordChannelMuteKey("c1", communityId, currentChannelIdHex)),
  );
  const communityMuted = Boolean(communityId && isCommunityMuted(`c1:${communityId}`));

  // Persist the open channel as this community's last-opened (local preference).
  useEffect(() => {
    if (!lastChannelKey || !channel) return;
    const hex = bytesToHex(channel.id);
    updateConfig((c) =>
      c.lastChannelByServer[lastChannelKey] === hex
        ? c
        : {
            ...c,
            lastChannelByServer: { ...c.lastChannelByServer, [lastChannelKey]: hex },
          },
    );
  }, [channel, lastChannelKey, updateConfig]);

  // Let `#channel-name` hashtags in chat jump to that local channel.
  const navChannels = useMemo(
    () =>
      (community?.channels ?? []).map((c) => ({
        name: c.name,
        go: () => setChannelIdHex(bytesToHex(c.id)),
      })),
    [community?.channels],
  );
  const channelNav = useChannelNavValue(navChannels);

  const { roster, setAdmin } = useConcordRosterActions(community);
  const ownerHex = roster?.ownerHex;
  const iAmOwner = Boolean(user && ownerHex && user.pubkey === ownerHex);
  const canManageRoles = Boolean(
    user && roster && isAuthorized(roster.roster, user.pubkey, ownerHex, Permissions.MANAGE_ROLES),
  );
  const canManageMetadata = Boolean(
    user && roster && isAuthorized(roster.roster, user.pubkey, ownerHex, Permissions.MANAGE_METADATA),
  );
  const canKickAny = Boolean(
    user && roster && isAuthorized(roster.roster, user.pubkey, ownerHex, Permissions.KICK),
  );
  const canBanAny = Boolean(
    user && roster && isAuthorized(roster.roster, user.pubkey, ownerHex, Permissions.BAN),
  );
  const canWrite = Boolean(user && channel);

  const { transport: baseTransport, reactionsFor, allMessages } = useConcordTransport(community, channel, canWrite, iAmOwner);
  const { mutateAsync: send } = useSendConcordMessage(community, channel);

  // Per-channel unread badges, computed purely from the local event store
  // (which the wire keeps fed with every channel's sealed outers).
  const { byChannel: unreadByChannel, markRead: markChannelRead } = useConcord1Unread(community);

  // Mark the open channel read up to its newest message while it's on screen —
  // immediately and again on tab refocus (mirrors the NIP-29/V2 behavior).
  const channelIdForRead = channel ? bytesToHex(channel.id) : undefined;
  useEffect(() => {
    if (!user || !channelIdForRead || allMessages.length === 0) return;
    const latest = allMessages[allMessages.length - 1]?.created_at ?? 0;
    if (latest <= 0) return;
    const stamp = () => {
      if (document.visibilityState === "visible") markChannelRead(channelIdForRead, latest);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [user, channelIdForRead, allMessages, markChannelRead]);

  const { createChannel, isAddingChannel } = useConcordActions();
  const { leave, isLeaving, dissolve } = useConcordCommunityActions(community, communityId);
  const { data: dissolved } = useConcordDissolved(community);
  const navigateTo = useNavigate();
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");

  // Close the inline create-channel form when switching communities — the
  // user's permission to create channels doesn't carry over.
  useEffect(() => {
    setCreatingChannel(false);
    setNewChannelName("");
  }, [communityId]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  /** Desktop: whether the member roster pane is shown. */
  const [membersVisible, setMembersVisible] = useState(true);
  /** Mobile: whether the member sheet is open. */
  const [membersOpen, setMembersOpen] = useState(false);
  // Mobile: landing on the community root (no channel in the URL) shows the
  // channel list, not a chat pane — selecting a community should let you pick a
  // channel, not auto-dive into one. A deep link with a channel opens chat
  // directly. (On desktop the SwipeReveal is inert — both panes always show.)
  const [channelsOpen, setChannelsOpen] = useState(!routeChannelId);
  // This page instance is reused across community switches (the route pattern
  // is stable), so the initial state above only applies to the first mount.
  // Reset the reveal state to match the destination route *during render* (not
  // in a post-paint effect): switching community navigates to its root
  // (no channel), so `channelsOpen` must already be `true` on the first render
  // after the route change. A lagging effect would paint one frame of the
  // (stale) chat pane first — the "flash of the previous chat" glitch. A deep
  // link with a channel opens chat directly.
  const [navKey, setNavKey] = useState(`${communityId}\u0000${routeChannelId ?? ""}`);
  const curNavKey = `${communityId}\u0000${routeChannelId ?? ""}`;
  if (navKey !== curNavKey) {
    setNavKey(curNavKey);
    setChannelsOpen(!routeChannelId);
  }
  // Slack-style threads: the root message whose thread panel is open (and
  // whether to focus its reply composer on open).
  const [threadRoot, setThreadRoot] = useState<ChatMsg | undefined>(undefined);
  const [threadAutoFocus, setThreadAutoFocus] = useState(false);
  const [lastThreadRoot, setLastThreadRoot] = useState<ChatMsg | undefined>(undefined);
  // The single message whose tap-to-reveal toolbar is open (touch only). Mirrors
  // GroupChat: without this, the action toolbar stays `touch:pointer-events-none`
  // and the react/reply/delete buttons never become tappable on the APK.
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback(
    (id: string) => setActiveId((cur) => (cur === id ? undefined : id)),
    [],
  );

  const openThread = useCallback((event: ChatMsg, focusReply = false) => {
    setThreadAutoFocus(focusReply);
    setThreadRoot(event);
  }, []);

  // Keep the thread panel content mounted through its slide-out animation.
  useEffect(() => {
    if (threadRoot) {
      setLastThreadRoot(threadRoot);
      return;
    }
    const t = setTimeout(() => setLastThreadRoot(undefined), 200);
    return () => clearTimeout(t);
  }, [threadRoot]);

  // Inject `openThread` (page-owned panel state) onto the data transport, so the
  // shared ChatMessage's reply action opens the thread.
  const transport = useMemo(() => ({ ...baseTransport, openThread }), [baseTransport, openThread]);

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
            // Distinguish the proven owner from delegated admins so the roster
            // can show a distinct owner badge (crown) vs admin badge (shield).
            .map((pubkey) => ({ pubkey, roles: pubkey === ownerHex ? ["owner"] : ["admin"] }))
        : [],
    [roster, ownerHex],
  );
  const memberPubkeys = useMemo(() => {
    const set = new Set<string>();
    if (roster) for (const m of concordMembers(roster)) set.add(m.pubkey);
    for (const m of allMessages) set.add(m.pubkey);
    if (user) set.add(user.pubkey);
    return [...set];
  }, [roster, allMessages, user]);

  // Stable open-thread callback so a per-message `ConcordChatMessage` doesn't
  // re-render just because the page did.
  const onOpenThreadCb = useMemo(
    () => (canWrite ? (event: ChatMsg) => openThread(event, true) : undefined),
    [canWrite, openThread],
  );

  const timelineRef = useRef<MessageTimelineHandle | null>(null);

  // Moderation: ban (read-cut), kick (cooperative), unban. The recipient set for
  // a ban's read-cut is everyone we know about minus the banned member.
  const moderation = useConcordModeration(community, memberPubkeys);

  // Typing indicators (ephemeral 3311).
  const publishTyping = useConcordTypingPublisher(community, channel);
  const { data: typingPubkeys } = useConcordTyping(community, channel);

  // A dissolved community is terminal — leave the page. (Declared before the
  // early return so the hook order stays stable.)
  useEffect(() => {
    if (dissolved) navigateTo("/");
  }, [dissolved, navigateTo]);

  if (!communityId) return <Navigate to="/" replace />;

  // Send a top-level message via the rich composer: the whole content is
  // sealed. The composer's content-derived tags (NIP-30 emoji, NIP-92 imeta,
  // NIP-27 mentions, NIP-18 quotes) are sealed verbatim so custom emoji, media
  // and mentions render — but the NIP-29 group `h` tag and any NIP-10 reply `e`
  // tags are dropped: Concord isn't a NIP-29 group, and replies are threaded
  // (a nested reply carries its root via the inner event's `reference`, sent
  // through the transport's `sendThreadReply`, not from the main composer).
  const handleSend = async (content: string, tags: string[][]) => {
    const extraTags = tags.filter(([name]) => name !== "h" && name !== "e");
    await send({ content, extraTags });
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
    } catch (e) {
      toast({
        title: "Couldn't leave",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
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

  /** Map the shared MemberList's role-string action onto Concord's grant model. */
  const handleSetRole = (pubkey: string, roles: string[]) => {
    setAdmin({ member: pubkey, admin: roles.includes("admin") }).catch(() => {});
  };

  /** Ban a member; warns when this signer can't perform the key read-cut. */
  const handleBan = async (pubkey: string) => {
    try {
      const { rekeyed } = await moderation.ban({ target: pubkey });
      if (rekeyed) {
        toast({ title: "Member banned", description: "Keys rotated; they can no longer read new messages." });
      } else {
        toast({
          title: "Member banned",
          description: "Added to the banlist. Sign in with your key (not a remote signer) to also rotate keys.",
        });
      }
    } catch (e) {
      toast({ title: "Couldn't ban", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  // The channel-list body, shared verbatim by the desktop sidebar and the
  // mobile drawer (so the two never drift — same chrome, same rows).
  const channelList = (onNavigate?: () => void, className?: string) => (
    <ChannelSidebarView
      className={className ?? (onNavigate ? "flex-1" : "hidden sidebar:flex")}
      title={community?.name ?? "…"}
      titleIcon={<CommunityTitleIcon icon={community?.icon} />}
      banner={<CommunityBanner banner={community?.banner} />}
      addChannelLabel={user && community ? "Add channel" : undefined}
      onAddChannel={user && community ? () => setCreatingChannel((v) => !v) : undefined}
      addChannelOpen={creatingChannel}
      footer={<ConcordSidebarFooter />}
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
        showChannelSkeleton ? (
          <div className="space-y-2 px-2 py-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : null
      ) : (
        community.channels.map((c) => {
          const idHex = bytesToHex(c.id);
          const active = Boolean(channel && bytesToHex(channel.id) === idHex);
          return (
            <ConcordChannelRow
              key={idHex}
              communityId={communityId!}
              channel={c}
              active={active}
              unread={unreadByChannel[idHex]}
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
    <ChannelNavContext.Provider value={channelNav}>
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            {/* The rail only ever navigates to *other* servers/communities, so
                it must NOT close this community's channel list on click: doing
                so slides this community's chat pane back in for a frame before
                the route changes — the "flash of the previous chat" glitch. The
                destination governs its own reveal state. (DMsPage omits the prop
                for the same reason.) */}
            <ServerRail />
            {channelList(() => setChannelsOpen(false), "flex-1 sidebar:flex-none")}
          </>
        }
      >
      {/* Chat */}
      <main className="flex-1 min-w-0 flex flex-col safe-area-top h-full">
        <header className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
          {/* Mobile back → slides the chat away to reveal the channel list.
              (The same reveal is also driven by a left-edge swipe.) */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to channels"
            className="size-9 shrink-0 sidebar:hidden"
            onClick={() => setChannelsOpen(true)}
          >
            <ChevronLeft className="size-5" />
          </Button>

          <Hash className="size-5 text-muted-foreground shrink-0" />
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
            {/* Mobile members button → opens the member sheet. */}
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
                  <Button variant="ghost" size="icon" className="size-8 touch:size-10" aria-label="Community actions">
                    <MoreVertical className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48 p-2">
                  {communityId && (
                    <>
                      <DropdownMenuItem
                        className="gap-3 px-3 py-2.5"
                        disabled={!currentChannelIdHex}
                        onClick={() => {
                          if (currentChannelIdHex) toggleConcordChannelMute("c1", communityId, currentChannelIdHex);
                        }}
                      >
                        {channelMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                        {channelMuted ? "Unmute channel" : "Mute channel"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="gap-3 px-3 py-2.5"
                        onClick={() => toggleCommunityMute(`c1:${communityId}`)}
                      >
                        {communityMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                        {communityMuted ? "Unmute community" : "Mute community"}
                      </DropdownMenuItem>
                    </>
                  )}
                  {canManageRoles && (
                    <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={() => setRolesOpen(true)}>
                      <Shield className="size-4" />
                      Manage roles
                    </DropdownMenuItem>
                  )}
                  {canManageMetadata && (
                    <DropdownMenuItem
                      className="gap-3 px-3 py-2.5"
                      onClick={() => setSettingsOpen(true)}
                    >
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
                    <DropdownMenuItem
                      className="gap-3 px-3 py-2.5 text-destructive focus:text-destructive"
                      onClick={handleDissolve}
                    >
                      <Trash2 className="size-4" />
                      Delete community
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>

        {/* Top-of-chat app stage (YouTube watchalong, webxdc) for this channel. */}
        {community && channel && (
          <AppStageSlot scope={{ kind: "concord", community, channel }} />
        )}

        {/* Chat + members. Member panel mirrors the NIP-29 GroupPage. */}
        <ChatScopeContext.Provider
          value={community && channel ? { kind: "concord", community, channel } : undefined}
        >
        <div className="relative flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 flex flex-col">
            <MessageTimeline
              key={channel ? bytesToHex(channel.id) : "none"}
              transport={transport}
              handleRef={timelineRef}
              className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4"
              emptyState={
                <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                  No messages yet. Say something — only members can read it.
                </p>
              }
              renderMessage={(msg, continuation) => (
                <ConcordChatMessage
                  key={msg.id}
                  event={msg}
                  reactions={reactionsFor(msg.id)}
                  replies={transport.threadRepliesFor?.(msg.id) ?? EMPTY_REPLIES}
                  continuation={continuation}
                  canWrite={transport.canWrite}
                  canModerate={transport.canModerate}
                  sendStatus={transport.sendStatusFor?.(msg.id)}
                  active={activeId === msg.id}
                  onToggleActive={toggleActive}
                  onOpenThread={onOpenThreadCb}
                  onDelete={transport.deleteMessage}
                  onRetry={transport.retry}
                  onDiscard={transport.discard}
                />
              )}
            />

            {(typingPubkeys?.length ?? 0) > 0 && (
              <TypingIndicator pubkeys={typingPubkeys!} />
            )}
            {channel && (
              <ChatComposer
                relayUrl="dm"
                groupId={channel ? bytesToHex(channel.id) : "concord"}
                messages={[]}
                mentionPubkeys={memberPubkeys}
                placeholder={user ? `Message #${channel.name}` : "Sign in to send"}
                sendOverride={handleSend}
                onTyping={publishTyping}
                encryptAttachments
              />
            )}
          </div>

          {/* Thread panel. Desktop: in-flow sibling whose width animates open.
              Mobile: overlays the chat (absolute). Mirrors GroupChat. */}
          <div
            className={cn(
              "overflow-hidden",
              "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
              "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
              threadRoot ? "sidebar:w-[23rem]" : "pointer-events-none sidebar:pointer-events-auto",
            )}
          >
            <div
              className={cn(
                "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
                threadRoot ? "opacity-100" : "opacity-0",
              )}
            />
            <div
              className={cn(
                "relative h-full flex w-full sidebar:w-[23rem] transition-transform duration-200 ease-out",
                threadRoot ? "translate-x-0" : "translate-x-full",
              )}
            >
              {lastThreadRoot && (
                <ThreadPanel
                  root={lastThreadRoot}
                  transport={transport}
                  relayUrl="dm"
                  groupId={channel ? bytesToHex(channel.id) : "concord"}
                  canWrite={canWrite}
                  mentionPubkeys={memberPubkeys}
                  autoFocus={threadAutoFocus}
                  onClose={() => setThreadRoot(undefined)}
                />
              )}
            </div>
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
        </ChatScopeContext.Provider>
      </main>
      </SwipeReveal>

      <InviteConcordDialog community={community} open={inviteOpen} onOpenChange={setInviteOpen} />
      <ConcordSettingsDialog community={community} open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ConcordRolesDialog community={community} open={rolesOpen} onOpenChange={setRolesOpen} />
    </ChannelNavContext.Provider>
  );
}

import { Bell, BellOff, CalendarClock, ChevronLeft, DoorOpen, Hash, IdCard, Loader2, Lock, LogOut, MessageSquareText, MoreVertical, Phone, Pin, ScrollText, Search, Settings2, Trash2, UserPlus, Users, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { BuzzCanvasBar } from "@/buzz/BuzzCanvas";
import { BuzzChat } from "@/buzz/BuzzChat";
import { BuzzDmName } from "@/buzz/BuzzDmName";
import { useIsBuzzRelay } from "@/buzz/detect";
import { buzzChannelTopic, buzzChannelType } from "@/buzz/protocol";
import { useBuzzOpenDm } from "@/buzz/useBuzzDms";
import { useBuzzPresence } from "@/buzz/useBuzzPresence";
import { CallStageSlot } from "@/components/chat/CallStageSlot";
import { AppStageSlot } from "@/components/chat/AppStage";
import { CalendarEventsBar } from "@/components/chat/CalendarEventsBar";
import { GroupChat } from "@/components/chat/GroupChat";
import { MemberList } from "@/components/chat/MemberList";
import { PinnedMessagesBar } from "@/components/chat/PinnedMessagesBar";
import { GroupBannerImage } from "@/components/GroupBannerImage";
import { CreateEventDialog } from "@/components/dialogs/CreateEventDialog";
import { GroupSettingsDialog } from "@/components/dialogs/GroupSettingsDialog";
import { InvitePeopleDialog } from "@/components/dialogs/InvitePeopleDialog";
import { ServerProfileDialog } from "@/components/dialogs/ServerProfileDialog";
import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { ChannelNavContext } from "@/contexts/ChannelNavContext";
import { ChatScopeContext } from "@/contexts/ChatScopeContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCall } from "@/hooks/useCall";
import { useChannelNavValue } from "@/hooks/useChannelNav";
import { useGroup } from "@/hooks/useGroup";
import { useGroupMembership, useJoinGroup, useLeaveGroup } from "@/hooks/useGroupMembership";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useRelayMembers } from "@/hooks/useRelayMembers";
import { useHeaderOverflow } from "@/hooks/useHeaderOverflow";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useRelayLivekitSupport } from "@/hooks/useLivekit";
import { channelMuteKey, useMutes } from "@/hooks/useMutes";
import { useNip29CalendarTransport } from "@/hooks/useCalendarEvents";
import { usePinnedMessages } from "@/hooks/usePinnedMessages";
import { useUpdateUserGroupList, useUserGroupList } from "@/hooks/useUserGroupList";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { toast } from "@/hooks/useToast";
import { relayToRouteParam, routeParamToRelay } from "@/lib/platform";
import { relayRejectionMessage, type Nip29Admin } from "@/lib/nip29";
import { cn } from "@/lib/utils";

function JoinBanner({ relayUrl, groupId, isClosed }: { relayUrl: string; groupId: string; isClosed: boolean }) {
  const join = useJoinGroup(relayUrl, groupId);
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const [searchParams] = useSearchParams();
  // Accept Armada's `?code=`, Flotilla/Coracle's `?c=`, and the standardized
  // NIP-29 `?invite=` (the naddr invite-code suffix, see buildGroupNaddr).
  const inviteCode = searchParams.get("code") ?? searchParams.get("c") ?? searchParams.get("invite") ?? "";
  const [code, setCode] = useState(inviteCode);
  const autoJoined = useRef(false);

  const handleJoin = useCallback(async () => {
    try {
      await join.mutateAsync({ code: code.trim() || undefined });
      // Joining a channel is the explicit intent that brings this server onto
      // the rail: `add-group` carries the server into the 10009 list, which is
      // the only place the rail reads NIP-29 communities from.
      updateList({ type: "add-group", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({ title: "Join request sent", description: "The relay will admit you automatically or after review." });
    } catch (e) {
      toast({
        title: "Couldn't join",
        description: relayRejectionMessage(e),
        variant: "destructive",
      });
    }
  }, [join, code, updateList, groupId, relayUrl]);

  // Shared invite link → join automatically once on arrival.
  useEffect(() => {
    if (inviteCode && !autoJoined.current && !join.isPending) {
      autoJoined.current = true;
      void handleJoin();
    }
  }, [inviteCode, join.isPending, handleJoin]);

  return (
    <div className="flex flex-wrap items-center gap-2 mx-2 mt-2 px-4 py-2.5 clip-corner-lg bg-chrome">
      <DoorOpen className="size-4 text-primary shrink-0" />
      <span className="text-sm flex-1 min-w-40">
        You're not a member of this channel{isClosed ? " — it's invite-only" : ""}.
      </span>
      {isClosed && (
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Invite code"
          className="h-8 w-36 text-sm"
        />
      )}
      <Button size="sm" className="h-8" onClick={handleJoin} disabled={join.isPending}>
        {join.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Join channel"}
      </Button>
    </div>
  );
}

/**
 * A channel (NIP-29 group): header, optional voice bar, chat timeline,
 * member panel, join/leave and admin controls.
 */
export function GroupPage() {
  const { server, groupId: rawGroupId } = useParams<{ server: string; groupId: string }>();
  const relayUrl = server ? routeParamToRelay(server) : undefined;
  const groupId = rawGroupId ? decodeURIComponent(rawGroupId) : undefined;

  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const navigate = useNavigate();
  const { data: details, isLoading } = useGroup(relayUrl, groupId);
  // Community-level (NIP-43, kind 13534) roster. On Buzz relays a member's
  // owner/admin role is granted for the whole community and applies in every
  // channel — separate from the per-channel NIP-29 admin list in `details`.
  const { data: relayMemberRoles } = useRelayMembers(relayUrl);
  const { data: membership, isLoading: membershipLoading } = useGroupMembership(relayUrl, groupId);
  const { data: relayHasLivekit } = useRelayLivekitSupport(relayUrl);
  // Buzz relays (NIP-29-based, detected via NIP-11) swap the chat surface for
  // BuzzChat and drop the NIP-29-only extras their relay doesn't speak
  // (pins/calendar/polls); they gain a canvas panel + typing indicators.
  const { isBuzz } = useIsBuzzRelay(relayUrl);
  // Live Buzz presence (ephemeral heartbeats; also publishes the viewer's).
  const buzzPresence = useBuzzPresence(isBuzz ? relayUrl : undefined);
  const openBuzzDm = useBuzzOpenDm(isBuzz ? relayUrl : undefined);
  const handleBuzzMessage = useCallback(
    async (peer: string) => {
      if (!relayUrl) return;
      try {
        const dmId = await openBuzzDm(peer);
        navigate(`/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(dmId)}`);
      } catch (e) {
        toast({
          title: "Couldn't start the conversation",
          description: relayRejectionMessage(e),
          variant: "destructive",
        });
      }
    },
    [relayUrl, openBuzzDm, navigate],
  );
  const leave = useLeaveGroup(relayUrl ?? "", groupId ?? "");
  const { removeUser, putUser, deleteGroup } = useGroupModeration(relayUrl ?? "", groupId ?? "");
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { data: userGroupList } = useUserGroupList();
  const { mutedChannels, isCommunityMuted, toggleChannelMute, toggleCommunityMute } = useMutes();
  // Individual mute states (not the cascaded isChannelMuted view): the ⋮ menu
  // shows "Mute channel" and "Mute server" side by side, so each item must
  // reflect only its own scope — a muted server must not flip the channel item
  // to "Unmute channel" (toggling it would add a pointless channel mute).
  const channelMuted = Boolean(relayUrl && groupId && mutedChannels.has(channelMuteKey(relayUrl, groupId)));
  const serverMuted = Boolean(relayUrl && isCommunityMuted(relayUrl));
  const { activeCall, joinCall } = useCall();
  const isTouchDevice = useIsTouch();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  /** Whether the desktop member roster is shown (toggled from the header),
   * persisted in app config (`memberListVisible`). Defaults OFF on touch devices
   * (phones/tablets — including a landscape phone that crosses the 900px sidebar
   * breakpoint but is too short to spare the roster width); the user can still
   * open it from the header toggle. On real desktop it stays on by default. Once
   * the user hides or shows it, that choice is remembered across visits. */
  const membersVisible = config.memberListVisible ?? !isTouchDevice;
  const toggleMembersVisible = () =>
    updateConfig((c) => ({ ...c, memberListVisible: !(c.memberListVisible ?? !isTouchDevice) }));
  /** Whether the header search bar is expanded, and its current query text. */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  /** Whether the pinned-messages bar is expanded below the header. */
  const [pinsOpen, setPinsOpen] = useState(false);
  /** Whether the events bar is expanded below the header, and the create/edit dialog. */
  const [eventsOpen, setEventsOpen] = useState(false);
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [serverProfileOpen, setServerProfileOpen] = useState(false);

  const isAdmin = useMemo(() => {
    if (!user) return false;
    // Per-channel NIP-29 admin (39001), OR a community-wide owner/admin (NIP-43
    // kind 13534) — the relay authorizes the latter to moderate every channel.
    if (details?.admins.some((a) => a.pubkey === user.pubkey)) return true;
    const communityRole = relayMemberRoles?.[user.pubkey.toLowerCase()];
    return communityRole === "owner" || communityRole === "admin";
  }, [user, details?.admins, relayMemberRoles]);

  // Roster shown in the member panel: fold the community owner/admins (NIP-43)
  // into the per-channel admins (39001) so a community admin surfaces with the
  // right badge even when they aren't in this channel's admin event. A role
  // present in both wins the higher rank (owner > admin).
  const mergedAdmins = useMemo<Nip29Admin[]>(() => {
    const roles = new Map<string, Set<string>>();
    for (const a of details?.admins ?? []) {
      roles.set(a.pubkey, new Set(a.roles.map((r) => r.toLowerCase())));
    }
    for (const [pubkey, role] of Object.entries(relayMemberRoles ?? {})) {
      if (role !== "owner" && role !== "admin") continue;
      const set = roles.get(pubkey) ?? new Set<string>();
      set.add(role);
      roles.set(pubkey, set);
    }
    return [...roles.entries()].map(([pubkey, set]) => ({ pubkey, roles: [...set] }));
  }, [details?.admins, relayMemberRoles]);

  // Let `#channel-name` hashtags in chat jump to that channel on this server.
  const { data: relayGroups } = useRelayGroups(relayUrl);
  const navChannels = useMemo(
    () =>
      relayUrl
        ? (relayGroups ?? []).map((g) => ({
            name: g.name,
            go: () => navigate(`/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(g.id)}`),
          }))
        : [],
    [relayGroups, relayUrl, navigate],
  );
  const channelNav = useChannelNavValue(navChannels);

  const { pinnedRefs, unpin } = usePinnedMessages(relayUrl, groupId);
  const hasPins = pinnedRefs.length > 0;

  const calendar = useNip29CalendarTransport(relayUrl, groupId, isAdmin);
  const hasEvents = calendar.events.length > 0;

  // Header action overflow. Pins + Events are the lower-priority toggles; on a
  // narrow phone (e.g. iPhone SE) where the bar can't fit everything alongside
  // the channel name, they fold into the channel-info (⋮) menu. Events folds
  // first, then pins. Measured (not breakpoint'd) because the action set is
  // conditional, so a fixed breakpoint would mis-collapse. Must be called
  // before any early return (rules-of-hooks).
  // Buzz relays don't speak the pins (9010/39005) or calendar (NIP-52) extensions,
  // so those toggles are dropped there; the canvas panel takes their place.
  const showEvents = !isBuzz && (hasEvents || isAdmin);
  const showPins = !isBuzz && hasPins;
  /** Whether the Buzz canvas bar is expanded below the header. */
  const [canvasOpen, setCanvasOpen] = useState(false);
  const collapsibleCount = (showEvents ? 1 : 0) + (showPins ? 1 : 0);
  const { ref: headerActionsRef, overflowCount } = useHeaderOverflow(collapsibleCount);
  // Collapse order: events first (overflowCount >= 1), then pins (>= 2).
  const eventsCollapsed = showEvents && overflowCount >= 1;
  const pinsCollapsed = showPins && overflowCount >= (showEvents ? 2 : 1);

  const searchInputRef = useRef<HTMLInputElement>(null);
  // Lets the pinned-messages bar jump to a message in the timeline; GroupChat
  // assigns the scroll function into this ref.
  const scrollToMessageRef = useRef<((id: string) => void) | null>(null);
  // Focus the search field when it expands. `preventScroll` is essential: the
  // input starts off-screen (left-full) and slides in, so a default focus()
  // makes the browser scroll the whole page to reveal it — a visible jolt.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);
  // Collapse the pinned bar if everything gets unpinned while it's open.
  useEffect(() => {
    if (pinsOpen && !hasPins) setPinsOpen(false);
  }, [pinsOpen, hasPins]);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  // Discord-style "back": slide the chat away to reveal this server's channel
  // list (the parent drill-down level), and HOLD it open so the user can pick a
  // channel. Driven by the left-edge swipe and the header chevron. Tapping a
  // channel navigates and closes; the list stays put otherwise.
  const [channelsOpen, setChannelsOpen] = useState(false);
  // Closing on navigation away from this group (a channel tap pushes a new
  // route → this component re-renders for the new groupId) keeps the freshly
  // opened chat flush instead of leaving the list revealed.
  useEffect(() => {
    setChannelsOpen(false);
  }, [groupId]);
  // Remember this as the server's last-opened channel, so returning to the
  // server re-opens it (see ServerPage's auto-open). Local-only preference.
  useEffect(() => {
    if (!relayUrl || !groupId) return;
    updateConfig((c) =>
      c.lastChannelByServer[relayUrl] === groupId
        ? c
        : {
            ...c,
            lastChannelByServer: { ...c.lastChannelByServer, [relayUrl]: groupId },
          },
    );
  }, [relayUrl, groupId, updateConfig]);

  // NOTE: visiting this route deliberately does NOT put the server on the
  // rail. It used to, writing a local-only cache that the kind 10009 list knew
  // nothing about — and because this effect fires on any mount the user didn't
  // choose (a notification tap, the last-channel restore, back-navigation, the
  // quick switcher), it silently undid removals, which is what the removed
  // tombstone hack existed to veto. The rail now shows exactly the 10009 list,
  // and a server enters it only by explicit action: joining a channel here
  // (`add-group` carries the server) or adding it in Settings/Add/invite.

  const group = details?.group;
  // Buzz channel type (stream/forum/dm/workflow) from the 39000 `t` tag.
  const buzzType = isBuzz && group ? buzzChannelType(group.event) : undefined;
  const buzzTopic = isBuzz && group ? buzzChannelTopic(group.event) : undefined;
  // The user's own kind 10009 list (NIP-51) is the locally-persisted,
  // cross-device source of truth for "groups I joined". Unlike the relay's
  // membership signals (kind 9000/9001, kind 39002 members), it's cached in the
  // folded plaintext IndexedDB store and survives an app reopen, so it resolves
  // instantly and offline. The relay queries, by contrast, run cold on reopen
  // and can come back empty/slow/AUTH-gated — which previously flipped a real
  // member back to the "Join channel" prompt. Treating presence in the user's
  // own list as a membership signal fixes that.
  const joinedLocally = Boolean(
    userGroupList?.groups.some((g) => g.id === groupId && g.relay === relayUrl),
  );
  // Admins may only appear in the kind 39001 admins list (e.g. the group
  // creator), not in 39002 members or via 9000 put-user events, so treat
  // admin status as membership too.
  const isMember =
    isAdmin ||
    joinedLocally ||
    Boolean(membership?.isMember) ||
    Boolean(user && details?.members.includes(user.pubkey));
  // NIP-29 relays generally only accept writes from members (relay29 always
  // does), so gate the composer on membership.
  const canWrite = Boolean(user) && isMember;
  // The ⋮ channel-info menu renders for any logged-in user (identity + mute
  // actions), and also whenever a pins/events action has overflowed into it
  // (so a logged-out visitor still reaches the collapsed toggle).
  const showChannelMenu = Boolean(user) || pinsCollapsed || eventsCollapsed;
  // Membership is a TRI-STATE: while the group details or the membership query
  // are still resolving and we don't yet have a positive membership signal, the
  // member-vs-not answer is UNKNOWN — not "not a member". Surfacing the "join to
  // message" prompt during this window flashes it at actual members. When a
  // logged-in user is in this ambiguous window, the composer area shows a
  // skeleton instead of the join prompt.
  const membershipPending = Boolean(user) && !isMember && (isLoading || membershipLoading);
  // NOTE: there is deliberately NO automatic `add-server` publish here. The
  // kind 10009 list is only ever written by an explicit user action (joining a
  // channel — `add-group` carries the server along — or adding a server in
  // Settings/Add/invite accept). A membership-gated auto-sync used to live
  // here and twice destroyed users' lists: it fired on passive visits (deep
  // links, last-channel restore) and its read-modify-write could race a cold
  // relay pool into rebuilding the list from empty.

  if (!relayUrl || !groupId) {
    return <Navigate to="/" replace />;
  }

  // Voice is available when the group is tagged `livekit` or the relay
  // advertises the NIP-29 LiveKit extension for all its groups.
  const hasVoice = Boolean(group?.hasLivekit || relayHasLivekit);
  // Whether the active app-level call is this channel's room.
  const inThisCall = activeCall?.relayUrl === relayUrl && activeCall?.groupId === groupId;

  const handleLeave = async () => {
    try {
      await leave.mutateAsync({});
      updateList({ type: "remove-group", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({ title: "Left channel" });
    } catch (e) {
      toast({
        title: "Leave failed",
        description: relayRejectionMessage(e),
        variant: "destructive",
      });
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${group?.name ?? groupId}"? This removes the channel for everyone and cannot be undone.`)) {
      return;
    }
    try {
      await deleteGroup.mutateAsync({});
      updateList({ type: "remove-group", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({ title: "Channel deleted" });
    } catch (e) {
      toast({
        title: "Delete failed",
        description: relayRejectionMessage(e),
        variant: "destructive",
      });
    }
  };

  return (
    <ServerScopeProvider relayUrl={relayUrl}>
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            {/* The rail navigates to *other* servers/communities, so it must
                NOT close this server's channel list on click: that slides the
                chat pane back in for a frame before the route changes — the
                "flash of the previous chat" glitch. The ChannelSidebar below
                (same-server channel taps) does close it. (DMsPage omits the
                rail prop for the same reason.) */}
            <ServerRail />
            <ChannelSidebar
              relayUrl={relayUrl}
              onNavigate={() => setChannelsOpen(false)}
              className="flex-1 sidebar:flex-none"
            />
          </>
        }
      >
        <main className="flex-1 min-w-0 flex flex-col safe-area-top h-full">
        {/* Channel header — detached floating command bar, matching the right
            roster: same margin, cut-corner card, and recessed chrome shade. */}
        <header
          ref={headerActionsRef}
          className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome"
        >
          {/* Mobile back → slides the chat away to reveal the channel list.
              (The same reveal is also driven by a left-edge swipe.) */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to channels"
            className="size-9 touch:size-11 shrink-0 sidebar:hidden"
            onClick={() => setChannelsOpen(true)}
          >
            <ChevronLeft className="size-5" />
          </Button>

          {buzzType === "dm"
            ? <MessageSquareText className="size-5 text-muted-foreground shrink-0" />
            : group?.hasLivekit
              ? <Volume2 className="size-5 text-muted-foreground shrink-0" />
              : <Hash className="size-5 text-muted-foreground shrink-0" />}
          {/* Title keeps a min-width floor so the action buttons can't squeeze
              it to nothing — instead the row overflows, which is what
              useHeaderOverflow measures to fold pins/events into the ⋮ menu. */}
          <div className="min-w-[5rem] flex-1">
            <h1 className="font-semibold truncate leading-tight">
              {isLoading
                ? "…"
                : buzzType === "dm"
                  ? <BuzzDmName members={details?.members ?? []} selfPubkey={user?.pubkey} />
                  : group?.name ?? groupId}
            </h1>
            {(buzzTopic || group?.about) && (
              <p className="text-xs text-muted-foreground truncate">{buzzTopic || group?.about}</p>
            )}
          </div>
          {group?.isPrivate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock className="size-4 text-muted-foreground" aria-label="Members-only channel" />
              </TooltipTrigger>
              <TooltipContent>Members-only — only members can read</TooltipContent>
            </Tooltip>
          )}
          {hasVoice && !inThisCall && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Join voice"
                  className="size-8 touch:size-11 text-muted-foreground hover:text-success"
                  onClick={() => joinCall(relayUrl, groupId)}
                >
                  <Phone className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Join voice</TooltipContent>
            </Tooltip>
          )}
          {/* Buzz canvas — toggles the shared-document bar below the header. */}
          {isBuzz && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Canvas"
                  aria-pressed={canvasOpen}
                  className={cn("size-8 touch:size-11 text-muted-foreground", canvasOpen && "text-foreground")}
                  onClick={() => setCanvasOpen((v) => !v)}
                >
                  <ScrollText className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Canvas</TooltipContent>
            </Tooltip>
          )}
          {/* Pinned messages — toggles the browse bar below the header. Folds
              into the ⋮ menu when the header runs out of room (pinsCollapsed). */}
          {showPins && !pinsCollapsed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Pinned messages"
                  aria-pressed={pinsOpen}
                  className={cn("size-8 touch:size-11 text-muted-foreground", pinsOpen && "text-foreground")}
                  onClick={() => setPinsOpen((v) => !v)}
                >
                  <Pin className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pinned messages</TooltipContent>
            </Tooltip>
          )}
          {/* Calendar events — toggles the events bar below the header. Folds
              into the ⋮ menu first when space is tight (eventsCollapsed). */}
          {showEvents && !eventsCollapsed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Events"
                  aria-pressed={eventsOpen}
                  className={cn("size-8 touch:size-11 text-muted-foreground", eventsOpen && "text-foreground")}
                  onClick={() => setEventsOpen((v) => !v)}
                >
                  <CalendarClock className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Events</TooltipContent>
            </Tooltip>
          )}
          {/* Search messages in this channel — expands inline below. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Search messages"
                aria-pressed={searchOpen}
                className={cn("size-8 touch:size-11 text-muted-foreground", searchOpen && "text-foreground")}
                onClick={() => setSearchOpen(true)}
              >
                <Search className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Search messages</TooltipContent>
          </Tooltip>
          {/* Mobile members button → opens the member sheet. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Members"
            aria-pressed={membersOpen}
            className="size-8 touch:size-11 sidebar:hidden"
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
                aria-label={membersVisible ? "Hide members" : "Show members"}
                aria-pressed={membersVisible}
                className={cn(
                  "size-8 hidden sidebar:inline-flex text-muted-foreground",
                  membersVisible && "text-foreground",
                )}
                onClick={toggleMembersVisible}
              >
                <Users className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{membersVisible ? "Hide members" : "Show members"}</TooltipContent>
          </Tooltip>
          {showChannelMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More options"
                  className="size-8 touch:size-11 text-muted-foreground"
                >
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 p-1.5">
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
                  {group?.name ?? "Channel"}
                </DropdownMenuLabel>
                {/* Pins / Events overflow here when the header is too narrow to
                    show them inline. They keep their toggle behavior + active
                    state (a check-style highlight when the browse bar is open). */}
                {(pinsCollapsed || eventsCollapsed) && (
                  <>
                    {pinsCollapsed && (
                      <DropdownMenuItem
                        className={cn("px-3 py-2", pinsOpen && "text-foreground font-medium")}
                        onClick={() => setPinsOpen((v) => !v)}
                      >
                        <Pin className="size-4" />
                        Pinned messages
                      </DropdownMenuItem>
                    )}
                    {eventsCollapsed && (
                      <DropdownMenuItem
                        className={cn("px-3 py-2", eventsOpen && "text-foreground font-medium")}
                        onClick={() => setEventsOpen((v) => !v)}
                      >
                        <CalendarClock className="size-4" />
                        Events
                      </DropdownMenuItem>
                    )}
                    {user && <DropdownMenuSeparator />}
                  </>
                )}
                {user && (
                  <>
                    <DropdownMenuItem
                      className="px-3 py-2"
                      onClick={() => toggleChannelMute(relayUrl, groupId)}
                    >
                      {channelMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                      {channelMuted ? "Unmute channel" : "Mute channel"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="px-3 py-2"
                      onClick={() => toggleCommunityMute(relayUrl)}
                    >
                      {serverMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                      {serverMuted ? "Unmute server" : "Mute server"}
                    </DropdownMenuItem>
                  </>
                )}
                {user && (
                  <DropdownMenuItem className="px-3 py-2" onClick={() => setServerProfileOpen(true)}>
                    <IdCard className="size-4" />
                    Server identity
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <DropdownMenuItem className="px-3 py-2" onClick={() => setInviteOpen(true)}>
                    <UserPlus className="size-4" />
                    Invite people
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <DropdownMenuItem className="px-3 py-2" onClick={() => setSettingsOpen(true)}>
                    <Settings2 className="size-4" />
                    Channel settings
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={handleDelete}
                      disabled={deleteGroup.isPending}
                      className="px-3 py-2 text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-4" />
                      Delete channel
                    </DropdownMenuItem>
                  </>
                )}
                {user && isMember && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={handleLeave}
                      disabled={leave.isPending}
                      className="px-3 py-2 text-destructive focus:text-destructive"
                    >
                      <LogOut className="size-4" />
                      Leave channel
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Inline search bar: smoothly expands across the header (covering the
              title and actions) when open. On mobile it leaves the menu button
              visible; on desktop it covers the full bar. An X dismisses it.
              Slides via GPU-composited transform (not `left`) so it animates on
              the compositor and never forces a per-frame reflow / jitter. */}
          <div
            className={cn(
              "absolute inset-y-0 right-0 left-10 sidebar:left-0 z-10 flex items-center gap-1.5 px-2 sidebar:px-3",
              "bg-chrome clip-corner-lg overflow-hidden",
              "transition-transform duration-300 ease-in-out",
              searchOpen
                ? "translate-x-0 pointer-events-auto"
                : "translate-x-full pointer-events-none",
            )}
          >
            <Search className="size-4 text-muted-foreground shrink-0" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
              placeholder="Search this channel…"
              className="h-8 touch:h-10 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close search"
              className="size-8 touch:size-10 shrink-0 text-muted-foreground"
              onClick={closeSearch}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        {/* Channel banner — the kind-39000 `banner` tag, a header image above
            the group content (Discord-style community branding). */}
        {group?.banner && (
          <div className="mx-2 mt-2 h-24 shrink-0 overflow-hidden clip-corner-lg">
            <GroupBannerImage src={group.banner} className="size-full object-cover" />
          </div>
        )}

        {/* Buzz canvas bar — the channel's shared document, below the header. */}
        {isBuzz && (
          <BuzzCanvasBar
            open={canvasOpen}
            relayUrl={relayUrl}
            channelId={groupId}
            onClose={() => setCanvasOpen(false)}
          />
        )}

        {/* Pinned messages bar — slides open below the header. */}
        <PinnedMessagesBar
          open={pinsOpen}
          pinnedRefs={pinnedRefs}
          relayUrl={relayUrl}
          canModerate={isAdmin}
          onJump={(id) => scrollToMessageRef.current?.(id)}
          onUnpin={(id) => { void unpin(id); }}
          onClose={() => setPinsOpen(false)}
        />

        {/* Calendar events bar — slides open below the header. */}
        <CalendarEventsBar
          open={eventsOpen}
          calendar={calendar}
          onClose={() => setEventsOpen(false)}
          onCreate={() => setCreateEventOpen(true)}
          onDelete={(event) => { void calendar.remove(event); }}
        />

        {/* Top-of-chat call stage: the active call's participants + video tiles
            portal in here (dismissable, toggled from the corner call panel)
            when this channel is the one in call. */}
        <CallStageSlot active={inThisCall} />

        {/* Top-of-chat app stage: a running in-chat app (YouTube watchalong,
            webxdc) portals in here when this channel is the one it's open in. */}
        <AppStageSlot scope={{ kind: "nip29", relayUrl, groupId }} />

        {/* Join banner. Buzz relays always stamp `closed` on kind-39000 (open
            channels are still joinable at runtime, and Buzz has no NIP-29
            invite codes), so the closed/invite-code affordance is NIP-29-only. */}
        {user && !isMember && !isLoading && (
          <JoinBanner relayUrl={relayUrl} groupId={groupId} isClosed={Boolean(group?.isClosed) && !isBuzz} />
        )}

        {/* The active voice call (if any) renders as a persistent docked bar in
            MainLayout, so it survives navigation between channels/servers. */}

        {/* Chat + members. The member panel mirrors the thread panel: in-flow
            animated-width on desktop, full-screen floating card overlay on
            mobile (no drawer/backdrop). */}
        <ChatScopeContext.Provider value={{ kind: "nip29", relayUrl, groupId }}>
        <ChannelNavContext.Provider value={channelNav}>
        <div className="relative flex flex-1 min-h-0">
          {isBuzz ? (
            <BuzzChat
              relayUrl={relayUrl}
              channelId={groupId}
              channelType={buzzType}
              canWrite={canWrite}
              membershipPending={membershipPending}
              canModerate={isAdmin}
              searchQuery={searchOpen ? searchQuery : ""}
              scrollToMessageRef={scrollToMessageRef}
            />
          ) : (
            <GroupChat
              relayUrl={relayUrl}
              groupId={groupId}
              canWrite={canWrite}
              membershipPending={membershipPending}
              canModerate={isAdmin}
              searchQuery={searchOpen ? searchQuery : ""}
              scrollToMessageRef={scrollToMessageRef}
            />
          )}
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
                admins={mergedAdmins}
                members={details?.members ?? []}
                memberRoles={details?.memberRoles}
                presence={isBuzz ? buzzPresence : undefined}
                onMessage={isBuzz ? handleBuzzMessage : undefined}
                canModerate={isAdmin}
                viewerIsAdmin={isAdmin}
                currentUserPubkey={user?.pubkey}
                onRemove={(pubkey) => removeUser.mutate({ pubkey })}
                onSetRole={(pubkey, roles) => putUser.mutate({ pubkey, roles })}
                onEditProfile={() => setServerProfileOpen(true)}
                onClose={() => setMembersOpen(false)}
              />
            </div>
          </div>
        </div>
        </ChannelNavContext.Provider>
        </ChatScopeContext.Provider>
        </main>
      </SwipeReveal>

      {group && (
        <GroupSettingsDialog
          relayUrl={relayUrl}
          group={group}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
      {group && (
        <InvitePeopleDialog
          relayUrl={relayUrl}
          group={group}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
        />
      )}
      <ServerProfileDialog
        relayUrl={relayUrl}
        open={serverProfileOpen}
        onOpenChange={setServerProfileOpen}
      />
      <CreateEventDialog
        calendar={calendar}
        open={createEventOpen}
        onOpenChange={setCreateEventOpen}
      />
    </ServerScopeProvider>
  );
}

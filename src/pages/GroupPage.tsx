import { Bell, BellOff, CalendarClock, DoorOpen, Headphones, IdCard, Loader2, LogOut, MessageSquareText, Phone, Pin, ScrollText, Search, Settings2, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  ChatHeader,
  ChatHeaderAction,
  ChatHeaderActions,
  ChatHeaderAvatar,
  ChatHeaderBack,
  ChatHeaderMenuTrigger,
  ChatHeaderTitle,
  ChatHeaderViewItems,
} from "@/components/chat/ChatHeader";
import { ChatSearchBar } from "@/components/chat/ChatSearchBar";
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
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ProfileRelayHints } from "@/components/ProfileRelayHints";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { ChannelGlyph } from "@/concord/components/ChannelGlyph";
import { ChannelNavContext } from "@/contexts/ChannelNavContext";
import { ChatScopeContext } from "@/contexts/ChatScopeContext";
import { CustomEmojisProvider } from "@/hooks/useCustomEmojis";
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
import { useMobileMembersOverlay } from "@/hooks/useMobileMembersOverlay";
import { useRelayLivekitSupport } from "@/hooks/useLivekit";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { channelMuteKey, useMutes } from "@/hooks/useMutes";
import { useNip29CalendarTransport } from "@/hooks/useCalendarEvents";
import { usePinnedMessages } from "@/hooks/usePinnedMessages";
import { useUpdateUserGroupList, useUserGroupList } from "@/hooks/useUserGroupList";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { toast } from "@/hooks/useToast";
import { routeParamToRelay } from "@/lib/platform";
import { chatRoute } from "@/lib/routes";
import { relayRejectionMessage, type Nip29Admin } from "@/lib/nip29";
import { displayHost, sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { activateScope, nip29Scope } from "@/wire/activation";

function JoinBanner({ relayUrl, groupId, isClosed }: { relayUrl: string; groupId: string; isClosed: boolean }) {
  const join = useJoinGroup(relayUrl, groupId);
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const [searchParams] = useSearchParams();
  // Armada `?code=`, Flotilla/Coracle `?c=`, NIP-29 naddr `?invite=`.
  const inviteCode = searchParams.get("code") ?? searchParams.get("c") ?? searchParams.get("invite") ?? "";
  const [code, setCode] = useState(inviteCode);

  // Invite links only pre-fill the code; joining waits for the click.
  const handleJoin = useCallback(async () => {
    try {
      await join.mutateAsync({ code: code.trim() || undefined });
      // Joining is the explicit intent that puts the server in the 10009 list (the rail's source).
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

  return (
    <div className="flex flex-wrap items-center gap-2 mx-2 mt-2 px-4 py-2.5 clip-corner-lg bg-chrome">
      <DoorOpen className="size-4 text-primary shrink-0" />
      <span className="text-sm flex-1 min-w-40">
        {inviteCode ? (
          <>You've been invited to this channel on <span className="font-medium">{displayHost(relayUrl)}</span>.</>
        ) : (
          <>You're not a member of this {isClosed ? "invite-only " : ""}channel.</>
        )}
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
  // Community-level roles (NIP-43, kind 13534): on Buzz, owner/admin applies to every channel.
  const { data: relayMemberRoles } = useRelayMembers(relayUrl);
  const { data: membership, isLoading: membershipLoading } = useGroupMembership(relayUrl, groupId);
  const { data: relayHasLivekit } = useRelayLivekitSupport(relayUrl);
  const { data: relayInfo } = useRelayInfo(relayUrl);
  const serverName = relayInfo?.name || relayUrl?.replace(/^wss?:\/\//, "");
  // NIP-11 fields are relay-controlled, so sanitize.
  const serverIcon = useMediaSrc(sanitizeImageSrc(relayInfo?.icon));
  // Buzz relays get BuzzChat and drop pins/calendar/polls. `ready` gates the
  // chat SURFACE: before NIP-11 answers, GroupChat would publish plain NIP-29
  // reply shapes Buzz mishandles or rejects — not undoable.
  const { isBuzz, ready: relayModeReady } = useIsBuzzRelay(relayUrl);
  const buzzPresence = useBuzzPresence(isBuzz ? relayUrl : undefined);
  const openBuzzDm = useBuzzOpenDm(isBuzz ? relayUrl : undefined);
  const handleBuzzMessage = useCallback(
    async (peer: string) => {
      if (!relayUrl) return;
      try {
        const dmId = await openBuzzDm(peer);
        navigate(chatRoute({ kind: "nip29", relayUrl, groupId: dmId }));
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
  // Individual (not cascaded) mute states: the menu shows channel and server
  // mute side by side, each reflecting only its own scope.
  const channelMuted = Boolean(relayUrl && groupId && mutedChannels.has(channelMuteKey(relayUrl, groupId)));
  const serverMuted = Boolean(relayUrl && isCommunityMuted(relayUrl));
  const { activeCall, joinCall } = useCall();
  const isTouchDevice = useIsTouch();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  /** Desktop member roster visibility (`memberListVisible`); defaults off on touch devices. */
  const membersVisible = config.memberListVisible ?? !isTouchDevice;
  const toggleMembersVisible = () =>
    updateConfig((c) => ({ ...c, memberListVisible: !(c.memberListVisible ?? !isTouchDevice) }));
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pinsOpen, setPinsOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [serverProfileOpen, setServerProfileOpen] = useState(false);

  const isAdmin = useMemo(() => {
    if (!user) return false;
    // Per-channel admin (39001) or community-wide owner/admin (NIP-43 13534).
    if (details?.admins.some((a) => a.pubkey === user.pubkey)) return true;
    const communityRole = relayMemberRoles?.[user.pubkey.toLowerCase()];
    return communityRole === "owner" || communityRole === "admin";
  }, [user, details?.admins, relayMemberRoles]);

  // Fold community owner/admins (NIP-43) into the channel admins (39001);
  // the higher rank wins (owner > admin).
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

  const { data: relayGroups } = useRelayGroups(relayUrl);
  const navChannels = useMemo(
    () =>
      relayUrl
        ? (relayGroups ?? []).map((g) => ({
            name: g.name,
            go: () => navigate(chatRoute({ kind: "nip29", relayUrl, groupId: g.id })),
          }))
        : [],
    [relayGroups, relayUrl, navigate],
  );
  const channelNav = useChannelNavValue(navChannels);
  // Memoized: every message row reads this context.
  const chatScope = useMemo(
    () => (relayUrl && groupId ? { kind: "nip29" as const, relayUrl, groupId } : undefined),
    [relayUrl, groupId],
  );

  const { pinnedRefs, unpin } = usePinnedMessages(relayUrl, groupId);
  const hasPins = pinnedRefs.length > 0;

  const calendar = useNip29CalendarTransport(relayUrl, groupId, isAdmin);
  const hasEvents = calendar.events.length > 0;

  // Pins/Events fold into the ⋮ menu (events first) when the header overflows,
  // measured rather than breakpointed since the action set varies. Buzz lacks
  // pins (9010/39005) and calendar (NIP-52). Must precede any early return.
  const showEvents = !isBuzz && (hasEvents || isAdmin);
  const showPins = !isBuzz && hasPins;
  const [canvasOpen, setCanvasOpen] = useState(false);
  const collapsibleCount = (showEvents ? 1 : 0) + (showPins ? 1 : 0);
  const { ref: headerActionsRef, overflowCount } = useHeaderOverflow(collapsibleCount);
  const eventsCollapsed = showEvents && overflowCount >= 1;
  const pinsCollapsed = showPins && overflowCount >= (showEvents ? 2 : 1);

  useEffect(() => {
    if (pinsOpen && !hasPins) setPinsOpen(false);
  }, [pinsOpen, hasPins]);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  // Mobile "back": reveal and HOLD this server's channel list until a channel is tapped.
  const [channelsOpen, setChannelsOpen] = useState(false);
  // Close on group change so the new chat opens flush.
  useEffect(() => {
    setChannelsOpen(false);
  }, [groupId]);
  const [membersOpen, setMembersOpen] = useMobileMembersOverlay(
    `${relayUrl ?? ""}|${groupId ?? ""}`,
    channelsOpen,
  );
  // Being navigated into activates this server for the session (wire/activation.ts).
  useEffect(() => {
    if (relayUrl) activateScope(nip29Scope(relayUrl));
  }, [relayUrl]);
  // Last-opened channel for ServerPage's auto-open (local-only).
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

  // Visiting deliberately does NOT add the server to the rail: passive mounts
  // (notifications, restores, back-nav) silently undid removals. The rail is
  // exactly the 10009 list, changed only by explicit action.

  const group = details?.group;
  const buzzType = isBuzz && group ? buzzChannelType(group.event) : undefined;
  const buzzTopic = isBuzz && group ? buzzChannelTopic(group.event) : undefined;
  // The user's own 10009 list counts as membership: it's cached locally and
  // resolves instantly/offline, while relay membership queries can be
  // cold/empty/AUTH-gated on reopen and flash "Join channel" at members.
  const joinedLocally = Boolean(
    userGroupList?.groups.some((g) => g.id === groupId && g.relay === relayUrl),
  );
  // Admins may appear only in 39001, so they count as members.
  const isMember =
    isAdmin ||
    joinedLocally ||
    Boolean(membership?.isMember) ||
    Boolean(user && details?.members.includes(user.pubkey));
  // NIP-29 relays generally accept writes only from members.
  const canWrite = Boolean(user) && isMember;
  // Membership is TRI-STATE: while unresolved, show a skeleton instead of the
  // join prompt (which would flash at real members).
  const membershipPending = Boolean(user) && !isMember && (isLoading || membershipLoading);
  // Deliberately NO automatic `add-server` publish: an auto-sync here fired
  // on passive visits and raced cold pools into rebuilding lists from empty.

  if (!relayUrl || !groupId) {
    return <Navigate to="/" replace />;
  }

  // `livekit`-tagged group, or the relay advertises the NIP-29 LiveKit extension.
  const hasVoice = Boolean(group?.hasLivekit || relayHasLivekit);
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
      {/* Member kind-0s often live only on this relay, which general routing never asks. */}
      <ProfileRelayHints relays={relayUrl ? [relayUrl] : undefined} />
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            {/* The rail must NOT close the channel list on click (it'd flash the
                previous chat before the route changes). */}
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
        <ChatHeader ref={headerActionsRef}>
          <ChatHeaderBack onClick={() => setChannelsOpen(true)} />
          <ChatHeaderTitle
            // Floor: the row overflows instead, which useHeaderOverflow measures.
            className="min-w-[5rem]"
            glyph={(className) =>
              buzzType === "dm"
                ? <MessageSquareText className={className} />
                : <ChannelGlyph isPrivate={group?.isPrivate} occupied={group?.hasLivekit} className={className} />
            }
            title={
              isLoading
                ? "…"
                : buzzType === "dm"
                  ? <BuzzDmName members={details?.members ?? []} selfPubkey={user?.pubkey} />
                  : group?.name ?? groupId
            }
            topic={buzzTopic || group?.about}
            avatar={<ChatHeaderAvatar src={serverIcon} name={serverName} />}
            context={serverName}
          />
          <ChatHeaderActions>
            {hasVoice && (
              <ChatHeaderAction
                icon={inThisCall ? Headphones : Phone}
                label={inThisCall ? "In voice" : "Join voice"}
                className={cn(inThisCall && "text-success")}
                disabled={inThisCall}
                onClick={() => joinCall(relayUrl, groupId)}
              />
            )}
            <ChatHeaderAction
              icon={Search}
              label="Search messages"
              pressed={searchOpen}
              className="hidden sidebar:inline-flex"
              onClick={() => setSearchOpen(true)}
            />
            {isBuzz && (
              <ChatHeaderAction
                icon={ScrollText}
                label="Canvas"
                pressed={canvasOpen}
                onClick={() => setCanvasOpen((v) => !v)}
              />
            )}
            {showPins && !pinsCollapsed && (
              <ChatHeaderAction
                icon={Pin}
                label={pinsOpen ? "Hide pinned messages" : "Show pinned messages"}
                tooltip="Pinned messages"
                pressed={pinsOpen}
                onClick={() => setPinsOpen((v) => !v)}
              />
            )}
            {showEvents && !eventsCollapsed && (
              <ChatHeaderAction
                icon={CalendarClock}
                label={eventsOpen ? "Hide events" : "Show events"}
                tooltip="Events"
                pressed={eventsOpen}
                onClick={() => setEventsOpen((v) => !v)}
              />
            )}
            <DropdownMenu>
              <ChatHeaderMenuTrigger />
              <DropdownMenuContent align="end" className="w-52 p-1.5">
                <ChatHeaderViewItems
                  onSearch={() => setSearchOpen(true)}
                  onMembers={() => setMembersOpen(true)}
                  membersVisible={membersVisible}
                  onToggleMembers={toggleMembersVisible}
                />
                {/* Pins/Events overflowed from the header. */}
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
          </ChatHeaderActions>

          <ChatSearchBar
            open={searchOpen}
            value={searchQuery}
            onChange={setSearchQuery}
            onClose={closeSearch}
            placeholder="Search this channel…"
          />
        </ChatHeader>

        {group?.banner && (
          <div className="mx-2 mt-2 h-24 shrink-0 overflow-hidden clip-corner-lg">
            <GroupBannerImage src={group.banner} className="size-full object-cover" />
          </div>
        )}

        {isBuzz && (
          <BuzzCanvasBar
            open={canvasOpen}
            relayUrl={relayUrl}
            channelId={groupId}
            onClose={() => setCanvasOpen(false)}
          />
        )}

        <PinnedMessagesBar
          open={pinsOpen}
          pinnedRefs={pinnedRefs}
          relayUrl={relayUrl}
          canModerate={isAdmin}
          // A navigation (`/m/<id>`), not a scroll, so Back works and the chat's
          // permalink handling can load older pages.
          onJump={(id) => navigate(chatRoute({ kind: "nip29", relayUrl, groupId, messageId: id }))}
          onUnpin={(id) => { void unpin(id); }}
          onClose={() => setPinsOpen(false)}
        />

        <CalendarEventsBar
          open={eventsOpen}
          calendar={calendar}
          onClose={() => setEventsOpen(false)}
          onCreate={() => setCreateEventOpen(true)}
          onDelete={(event) => { void calendar.remove(event); }}
        />

        <CallStageSlot active={inThisCall} />

        <AppStageSlot scope={{ kind: "nip29", relayUrl, groupId }} />

        {/* Buzz stamps `closed` on every channel, so the closed/invite-code affordance is NIP-29-only. */}
        {user && !isMember && !isLoading && (
          <JoinBanner relayUrl={relayUrl} groupId={groupId} isClosed={Boolean(group?.isClosed) && !isBuzz} />
        )}

        <ChatScopeContext.Provider value={chatScope}>
        <CustomEmojisProvider>
        <ChannelNavContext.Provider value={channelNav}>
        <div className="relative flex flex-1 min-h-0">
          {!relayModeReady ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-label="Connecting to server" />
            </div>
          ) : isBuzz ? (
            <BuzzChat
              relayUrl={relayUrl}
              channelId={groupId}
              channelType={buzzType}
              canWrite={canWrite}
              membershipPending={membershipPending}
              canModerate={isAdmin}
              searchQuery={searchOpen ? searchQuery : ""}
            />
          ) : (
            <GroupChat
              relayUrl={relayUrl}
              groupId={groupId}
              canWrite={canWrite}
              membershipPending={membershipPending}
              canModerate={isAdmin}
              calendar={calendar}
              searchQuery={searchOpen ? searchQuery : ""}
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
            <div
              className={cn(
                "relative h-full flex w-full sidebar:w-[16.5rem] transition-transform duration-200 ease-out",
                membersOpen ? "translate-x-0" : "translate-x-full",
                membersVisible ? "sidebar:translate-x-0" : "sidebar:translate-x-full",
              )}
            >
              <div aria-hidden className="absolute inset-0 -z-10 bg-background sidebar:hidden" />
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
        </CustomEmojisProvider>
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

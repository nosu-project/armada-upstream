import { Bell, BellOff, CheckCheck, ChevronDown, FolderGit2, Hash, Headphones, IdCard, Link as LinkIcon, Loader2, Lock, MessageSquareText, MessagesSquare, Plus, RefreshCw, Trash2, Volume2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

import { BuzzDmName } from "@/buzz/BuzzDmName";
import { useIsBuzzRelay } from "@/buzz/detect";
import { buzzChannelArchived, buzzChannelType } from "@/buzz/protocol";
import { useBuzzHiddenDms } from "@/buzz/useBuzzDms";
import { CreateGroupDialog } from "@/components/dialogs/CreateGroupDialog";
import { ServerProfileDialog } from "@/components/dialogs/ServerProfileDialog";
import { JoinButton } from "@/components/auth/JoinButton";
import { LoginArea } from "@/components/auth/LoginArea";
import { VoiceParticipantList } from "@/components/VoicePresence";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { NotifLevelMenu } from "@/components/NotifLevelMenu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCall } from "@/hooks/useCall";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useGroup } from "@/hooks/useGroup";
import { useLivekitParticipants, useRelayLivekitSupport } from "@/hooks/useLivekit";
import { useNotifLevels, channelScopeKey } from "@/hooks/useNotifLevels";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayUnread, type GroupUnread } from "@/hooks/useRelayUnread";
import { useServerActions } from "@/hooks/useServerActions";
import { relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { writeClipboardText } from "@/lib/clipboard";
import { shareOrigin } from "@/lib/shareOrigin";

import type { Nip29Group } from "@/lib/nip29";

function ChannelLink({
  group,
  unread,
  onNavigate,
  buzzDm = false,
  dimmed = false,
}: {
  group: Nip29Group;
  unread?: GroupUnread;
  onNavigate?: () => void;
  /** Render as a Buzz DM row: participant names as the title, DM icon. */
  buzzDm?: boolean;
  /** Dim the row (archived Buzz channels). */
  dimmed?: boolean;
}) {
  const { user } = useCurrentUser();
  const { activeCall, speakingPubkeys, mutedPubkeys, voiceRoomPubkeys } = useCall();
  const { markRead } = useReadState();
  const { channelLevel, setLevel } = useNotifLevels();
  const muted = channelLevel(group.relay, group.id) === "nothing";
  // A Buzz DM channel's identity is its roster, so resolve the members
  // (kind 39002) for the title. Disabled (undefined relay) for normal rows.
  const { data: dmDetails } = useGroup(buzzDm ? group.relay : undefined, buzzDm ? group.id : undefined);
  // Voice capability: prefer the per-group `livekit` metadata tag, but fall
  // back to the relay-level capability (`/.well-known/nip29/livekit` 204).
  // Armada's relay29 metadata doesn't emit the `livekit` group tag, so
  // `group.hasLivekit` is false even though the relay speaks LiveKit — without
  // this fallback we'd never query presence and could only show a call when
  // *you* are in it (matching GroupPage's `hasVoice` gate).
  const { data: relayHasLivekit } = useRelayLivekitSupport(group.relay);
  const hasVoice = group.hasLivekit || Boolean(relayHasLivekit);
  const inCall = activeCall?.relayUrl === group.relay && activeCall?.groupId === group.id;
  const hasUnread = Boolean(unread);
  const hasMention = Boolean(unread?.mention);
  // Live presence (kind 39004) so we can show when others are in voice here,
  // even if we haven't joined. Only worth querying for voice-capable groups.
  const { data: participants } = useLivekitParticipants(
    hasVoice ? group.relay : undefined,
    hasVoice ? group.id : undefined,
  );
  const othersInVoice = !inCall && (participants?.length ?? 0) > 0;
  // Roster to render: while YOU are in this call, the connected room's live
  // LiveKit participant list is authoritative — kind-39004 presence rides
  // webhooks + relay memory and desyncs too easily. It's only the fallback
  // (and the only source for calls you're not in).
  const roster = inCall && voiceRoomPubkeys ? voiceRoomPubkeys : participants;
  // The audio icon should only appear when a call is actually live here (you're
  // in it or others are) — otherwise a voice-capable channel reads as a normal
  // text channel.
  const callActive = inCall || othersInVoice;
  const Icon = buzzDm ? MessageSquareText : callActive ? Volume2 : Hash;

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div>
          <NavLink
        to={`/s/${relayToRouteParam(group.relay)}/${encodeURIComponent(group.id)}`}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            // Slack-style selection: the active channel sits on a filled
            // primary rectangle with the house cut-corner chamfer. Inactive
            // rows are transparent with a subtle hover wash.
            "flex items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors",
            !isActive && "text-muted-foreground hover:text-foreground hover:bg-foreground/5 clip-corner-lg",
            // Unread (but not selected) channels read brighter + bold, matching
            // Slack. This is now visually distinct from the active rectangle.
            // Muted channels never bold — their unread is deliberately silent.
            !isActive && hasUnread && !muted && "text-foreground font-semibold",
            // Muted channels read dimmer (Discord-style).
            !isActive && (muted || dimmed) && "opacity-60",
            // Active/navigated channel: primary-filled chamfered rectangle.
            isActive && "clip-corner-lg bg-primary text-primary-foreground font-medium",
          )}
      >
        <Icon className="size-4 shrink-0" />
        <span className="truncate flex-1">
          {buzzDm
            ? <BuzzDmName members={dmDetails?.members ?? []} selfPubkey={user?.pubkey} />
            : group.name}
        </span>
        {inCall && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Headphones className="size-3.5 shrink-0 text-success" aria-label="Voice active" />
            </TooltipTrigger>
            <TooltipContent>You're in voice here</TooltipContent>
          </Tooltip>
        )}
        {group.isPrivate && <Lock className="size-3 shrink-0 opacity-60" aria-label="Private" />}
        {muted && <BellOff className="size-3 shrink-0 opacity-60" aria-label="Muted" />}
        {/* Mention indicator: an "@" pill. Plain unread is conveyed by the
            row's brighter + bold text (no dot). */}
        {hasMention ? (
          <span
            className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none"
            aria-label="You were mentioned"
          >
            @
          </span>
        ) : null}
      </NavLink>
      {/* Discord-style nested voice roster: who's in the live call here (with
          live speaking rings while you're in it). */}
      {callActive && (roster?.length ?? 0) > 0 && (
        <VoiceParticipantList
          participants={roster!}
          speaking={inCall ? speakingPubkeys : undefined}
          muted={inCall ? mutedPubkeys : undefined}
        />
      )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem
          disabled={!hasUnread}
          onSelect={() => {
            if (unread) markRead(channelReadKey(group.relay, group.id), unread.latest);
          }}
        >
          <CheckCheck className="mr-2 size-4" /> Mark as read
        </ContextMenuItem>
        <NotifLevelMenu
          label="Notifications"
          level={channelLevel(group.relay, group.id)}
          onChange={(lvl) => setLevel(channelScopeKey(group.relay, group.id), lvl)}
        />
        <ContextMenuItem
          onSelect={() => {
            const url = `${shareOrigin()}/s/${relayToRouteParam(group.relay)}/${encodeURIComponent(group.id)}`;
            writeClipboardText(url).catch(() => undefined);
          }}
        >
          <LinkIcon className="mr-2 size-4" /> Copy channel link
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface ChannelSidebarProps {
  relayUrl: string;
  onNavigate?: () => void;
  className?: string;
}

/**
 * Channel list for a server: its NIP-29 groups, a create-channel action, and
 * the account area pinned to the bottom (Discord-style).
 */
export function ChannelSidebar({ relayUrl, onNavigate, className }: ChannelSidebarProps) {
  const { data: groups, isLoading, isError, refetch, relayInfo } = useRelayGroups(relayUrl);
  const { user } = useCurrentUser();
  const { registerCallBarSlot } = useCall();
  const callBarRef = useRef<HTMLDivElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // The server-name header menu (Discord-style): expands inline below the
  // header, pushing the channel list down with a height animation. This is the
  // only place these server actions are reachable on mobile, where the desktop
  // welcome pane (ServerPage) is hidden.
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const { serverMuted, isRemovable, toggleMute, copyLink, removeServer } =
    useServerActions(relayUrl);
  // Buzz relays: channels partition into typed sections (forum channels, DM
  // channels — hidden NIP-29 groups — and archived channels at the bottom).
  const { isBuzz } = useIsBuzzRelay(relayUrl);
  const hiddenDms = useBuzzHiddenDms(isBuzz ? relayUrl : undefined);
  const buzzSections = useMemo(() => {
    if (!isBuzz || !groups) return undefined;
    const streams: typeof groups = [];
    const forums: typeof groups = [];
    const dms: typeof groups = [];
    const archived: typeof groups = [];
    for (const g of groups) {
      if (buzzChannelArchived(g.event)) {
        archived.push(g);
        continue;
      }
      const type = buzzChannelType(g.event);
      if (type === "dm") {
        if (!hiddenDms.has(g.id)) dms.push(g);
      } else if (type === "forum") {
        forums.push(g);
      } else {
        streams.push(g);
      }
    }
    return { streams, forums, dms, archived };
  }, [isBuzz, groups, hiddenDms]);

  // Close the create-channel dialog when switching servers — its context (and
  // the user's permission to create) doesn't carry over to the new server.
  useEffect(() => {
    setCreateOpen(false);
    setProfileOpen(false);
    setServerMenuOpen(false);
  }, [relayUrl]);

  // Don't let skeletons run for the full connect/timeout window (which can be
  // 8–16s on a slow or AUTH-gated relay) — that reads as a hang. Show skeletons
  // briefly, then switch to an explicit "Connecting…" message.
  const [skeletonExpired, setSkeletonExpired] = useState(false);
  useEffect(() => {
    setSkeletonExpired(false);
    const t = setTimeout(() => setSkeletonExpired(true), 2500);
    return () => clearTimeout(t);
  }, [relayUrl]);

  // Cache hits resolve within a frame or two, so an ungated skeleton flashes for
  // a nanosecond (reads as a glitch). Only reveal the loading UI once loading
  // has lasted long enough to be worth a placeholder; a fast load shows nothing.
  const showLoadingUi = useDelayedFlag(isLoading);

  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const { byGroup } = useRelayUnread(relayUrl, groupIds);

  // Register this sidebar's slot so the persistent call bar portals above the
  // account pill. Every instance (desktop pane + mobile drawer) registers; the
  // hidden panes simply don't show their copy.
  useEffect(() => {
    const el = callBarRef.current;
    if (!el) return;
    return registerCallBarSlot(el);
  }, [registerCallBarSlot]);

  const serverName = relayInfo?.name || relayUrl.replace(/^wss?:\/\//, "");

  return (
    <ChannelSidebarView
      className={className}
      title={
        <button
          type="button"
          className="group flex w-full items-center gap-1 min-w-0 text-left cursor-pointer rounded outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setServerMenuOpen((v) => !v)}
          aria-label="Server menu"
          aria-expanded={serverMenuOpen}
        >
          {relayInfo?.icon && (
            <img src={relayInfo.icon} alt="" className="size-6 rounded object-cover shrink-0" />
          )}
          <span className="flex-1 truncate">{serverName}</span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              serverMenuOpen && "rotate-180",
            )}
          />
        </button>
      }
      titleExpansion={
        <Collapsible open={serverMenuOpen} onOpenChange={setServerMenuOpen}>
          <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
            <div className="mx-2 mb-2 mt-1 p-1 space-y-0.5 clip-corner-lg bg-secondary">
              {([
                {
                  show: !!user,
                  icon: <Plus className="size-4" />,
                  label: "Create channel",
                  onClick: () => setCreateOpen(true),
                },
                {
                  show: !!user,
                  icon: <IdCard className="size-4" />,
                  label: "Server identity",
                  onClick: () => setProfileOpen(true),
                },
                {
                  show: !!user,
                  icon: serverMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />,
                  label: serverMuted ? "Unmute server" : "Mute server",
                  onClick: toggleMute,
                },
                {
                  show: true,
                  icon: <LinkIcon className="size-4" />,
                  label: "Copy server link",
                  onClick: copyLink,
                },
                {
                  show: true,
                  icon: <RefreshCw className="size-4" />,
                  label: "Refresh channels",
                  onClick: () => refetch(),
                },
                {
                  show: isRemovable,
                  icon: <Trash2 className="size-4" />,
                  label: "Remove server",
                  onClick: removeServer,
                  destructive: true,
                },
              ] as Array<{
                show: boolean;
                icon: ReactNode;
                label: string;
                onClick: () => void;
                destructive?: boolean;
              }>)
                .filter((i) => i.show)
                .map((i) => (
                  <button
                    key={i.label}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-sm text-left transition-colors clip-corner-lg hover:bg-foreground/10",
                      i.destructive && "text-destructive",
                    )}
                    onClick={() => {
                      i.onClick();
                      setServerMenuOpen(false);
                    }}
                  >
                    {i.icon}
                    {i.label}
                  </button>
                ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      }
      banner={
        relayInfo?.banner ? (
          <div className="size-full overflow-hidden">
            <img src={relayInfo.banner} alt="" className="size-full object-cover" />
          </div>
        ) : undefined
      }
      addChannelLabel={user ? "Create channel" : undefined}
      onAddChannel={user ? () => setCreateOpen(true) : undefined}
      preChannels={
        isBuzz ? (
          <NavLink
            to={`/s/${relayToRouteParam(relayUrl)}/projects`}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors clip-corner-lg",
                isActive
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
              )
            }
          >
            <FolderGit2 className="size-4 shrink-0" />
            <span className="truncate flex-1 min-w-0">Projects</span>
          </NavLink>
        ) : undefined
      }
      footer={
        <>
          {/* Voice call bar slot — the persistent call UI portals here. */}
          <div ref={callBarRef} className="empty:hidden shrink-0" />

          {/* Account area. The extra pb-2 mirrors the composer's inner `p-2`
              (which sits inside its pb-safe wrapper) so the account switcher and
              the chat composer end at the SAME line above the safe-area inset —
              without it the switcher sat ~8px lower than the composer. */}
          <div className="px-3 pb-safe shrink-0">
            {user ? (
              <div className="pb-2">
                <LoginArea className="w-full flex" />
              </div>
            ) : (
              <div className="p-2 flex justify-center">
                <JoinButton className="w-full max-w-xs clip-corner-lg font-medium" />
              </div>
            )}
          </div>

          <CreateGroupDialog relayUrl={relayUrl} open={createOpen} onOpenChange={setCreateOpen} />
          <ServerProfileDialog relayUrl={relayUrl} open={profileOpen} onOpenChange={setProfileOpen} />
        </>
      }
    >
      {isLoading && !showLoadingUi ? (
        // Loading, but not long enough yet to warrant any placeholder — render
        // nothing so a fast cache hit doesn't flash a skeleton.
        null
      ) : isLoading && !skeletonExpired ? (
        <div className="space-y-2 px-2 py-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : isLoading ? (
        // Loading has outlasted the skeleton window — show an explicit,
        // non-looping "Connecting…" so it doesn't read as a hang.
        <div className="px-2 py-8 text-center text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Connecting to server…
          </span>
        </div>
      ) : buzzSections ? (
        <>
          {buzzSections.streams.map((group) => (
            <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} />
          ))}
          {buzzSections.forums.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 pl-4 pr-2 pt-3 pb-1">
                <MessagesSquare className="size-3 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Forums
                </span>
              </div>
              {buzzSections.forums.map((group) => (
                <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} />
              ))}
            </>
          )}
          {buzzSections.dms.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 pl-4 pr-2 pt-3 pb-1">
                <MessageSquareText className="size-3 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Direct messages
                </span>
              </div>
              {buzzSections.dms.map((group) => (
                <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} buzzDm />
              ))}
            </>
          )}
          {buzzSections.archived.length > 0 && (
            <>
              <div className="pl-4 pr-2 pt-3 pb-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                  Archived
                </span>
              </div>
              {buzzSections.archived.map((group) => (
                <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} dimmed />
              ))}
            </>
          )}
          {buzzSections.streams.length + buzzSections.forums.length + buzzSections.dms.length + buzzSections.archived.length === 0 && (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              No channels yet.
            </div>
          )}
        </>
      ) : groups && groups.length > 0 ? (
        groups.map((group) => (
          <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} />
        ))
      ) : isError && !groups ? (
        // The relay couldn't be reached (NIP-11 and the group query both failed).
        <div className="px-3 py-8 text-center text-sm text-muted-foreground space-y-3">
          <p>Couldn&rsquo;t reach this server. It may be offline or unreachable.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : (
        <div className="px-2 py-8 text-center text-sm text-muted-foreground">
          No channels yet.
        </div>
      )}
    </ChannelSidebarView>
  );
}

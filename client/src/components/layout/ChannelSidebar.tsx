import { Hash, Headphones, Loader2, Lock, Plus, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

import { CreateGroupDialog } from "@/components/dialogs/CreateGroupDialog";
import { LoginArea } from "@/components/auth/LoginArea";
import LoginDialog from "@/components/auth/LoginDialog";
import SignupDialog from "@/components/auth/SignupDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCall } from "@/hooks/useCall";
import { useLivekitParticipants } from "@/hooks/useLivekit";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayUnread, type GroupUnread } from "@/hooks/useRelayUnread";
import { relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";

import type { Nip29Group } from "@/lib/nip29";

function ChannelLink({
  group,
  unread,
  onNavigate,
}: {
  group: Nip29Group;
  unread?: GroupUnread;
  onNavigate?: () => void;
}) {
  const { activeCall } = useCall();
  const Icon = group.hasLivekit ? Volume2 : Hash;
  const inCall = activeCall?.relayUrl === group.relay && activeCall?.groupId === group.id;
  const hasUnread = Boolean(unread);
  const hasMention = Boolean(unread?.mention);
  // Live presence (kind 39004) so we can show when others are in voice here,
  // even if we haven't joined. Only worth querying for voice-capable groups.
  const { data: participants } = useLivekitParticipants(
    group.hasLivekit ? group.relay : undefined,
    group.hasLivekit ? group.id : undefined,
  );
  const othersInVoice = !inCall && (participants?.length ?? 0) > 0;

  return (
    <NavLink
      to={`/s/${relayToRouteParam(group.relay)}/${encodeURIComponent(group.id)}`}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          // Chart-rule HUD entry: a glowing left gutter-tick marks state
          // instead of a full-bleed grey hover block. Raked left padding
          // echoes the console's diagonal.
          "gutter-tick flex items-center gap-2 pl-4 pr-2 py-1.5 text-sm transition-colors",
          "text-muted-foreground hover:text-foreground",
          // Unread channels read brighter even when not selected.
          !isActive && hasUnread && "text-foreground font-medium",
          isActive && "is-active text-foreground font-medium",
        )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate flex-1">{group.name}</span>
      {inCall ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Headphones className="size-3.5 shrink-0 text-success" aria-label="Voice active" />
          </TooltipTrigger>
          <TooltipContent>You're in voice here</TooltipContent>
        </Tooltip>
      ) : othersInVoice ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-0.5 shrink-0 text-success/80" aria-label="Others in voice">
              <Headphones className="size-3.5" />
              <span className="text-[10px] tabular-nums">{participants!.length}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {participants!.length} in voice
          </TooltipContent>
        </Tooltip>
      ) : null}
      {group.isPrivate && <Lock className="size-3 shrink-0 opacity-60" aria-label="Private" />}
      {/* Unread / mention indicator: an "@" pill for mentions, else a dot. */}
      {hasMention ? (
        <span
          className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none"
          aria-label="You were mentioned"
        >
          @
        </span>
      ) : hasUnread ? (
        <span className="shrink-0 size-2 rounded-full bg-foreground" aria-label="Unread messages" />
      ) : null}
    </NavLink>
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
  const { data: groups, isLoading, relayInfo } = useRelayGroups(relayUrl);
  const { user } = useCurrentUser();
  const { registerCallBarSlot } = useCall();
  const callBarRef = useRef<HTMLDivElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);

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

  return (
    <aside
      className={cn(
        // Chrome plane — recessed, darker than the deck, identical to the rail,
        // header, and roster so they read as one frame around the bright chat.
        "relative flex flex-col w-60 shrink-0 bg-chrome",
        className,
      )}
    >
      {/* Server header — aligned with the channel rows' text gutter below
          (container px-1 + row pl-4 = pl-5 here) so the grid lines up. */}
      <div className="pl-5 pr-3 pt-5 pb-3 flex flex-col justify-center">
        <h2 className="font-semibold truncate leading-tight tracking-wide text-sm">
          {relayInfo?.name || relayUrl.replace(/^wss?:\/\//, "")}
        </h2>
        <span className="text-[11px] text-muted-foreground truncate leading-tight">
          {relayUrl.replace(/^wss?:\/\//, "").replace(/\/$/, "")}
        </span>
        {relayInfo?.limitation?.auth_required && (
          <Badge variant="secondary" className="mt-0.5 w-fit text-[10px] px-1.5 py-0">AUTH required</Badge>
        )}
      </div>

      {/* Divider between the server header and the channel list. */}
      <div className="mx-3 h-0.5 shrink-0 bg-chrome-divider" />

      {/* Channels */}
      <div className="flex-1 overflow-y-auto px-1 pt-[11px] pb-2 space-y-0.5">
        <div className="flex items-center justify-between pl-4 pr-2 py-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Channels
          </span>
          {user && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5"
                  aria-label="Create channel"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Create channel</TooltipContent>
            </Tooltip>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2 px-2 py-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : groups && groups.length > 0 ? (
          groups.map((group) => (
            <ChannelLink key={group.id} group={group} unread={byGroup[group.id]} onNavigate={onNavigate} />
          ))
        ) : (
          <div className="px-2 py-8 text-center text-sm text-muted-foreground">
            {groups ? "No channels yet." : (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> Connecting…
              </span>
            )}
          </div>
        )}
      </div>

      {/* Voice call bar slot — the persistent call UI portals here on desktop. */}
      {/* Voice call bar slot — the persistent call UI portals here. */}
      <div ref={callBarRef} className="empty:hidden shrink-0" />

      {/* Account area */}
      <div className="px-3 pb-safe shrink-0">
        {user ? (
          <LoginArea className="w-full flex" />
        ) : (
          <div className="p-2 flex justify-center">
            <Button
              onClick={() => setJoinOpen(true)}
              className="w-full max-w-xs rounded-full font-medium"
            >
              Join
            </Button>
          </div>
        )}
      </div>

      <LoginDialog
        isOpen={joinOpen}
        onClose={() => setJoinOpen(false)}
        onLogin={() => setJoinOpen(false)}
        onSignupClick={() => {
          setJoinOpen(false);
          setSignupOpen(true);
        }}
      />
      <SignupDialog isOpen={signupOpen} onClose={() => setSignupOpen(false)} />

      <CreateGroupDialog relayUrl={relayUrl} open={createOpen} onOpenChange={setCreateOpen} />
    </aside>
  );
}

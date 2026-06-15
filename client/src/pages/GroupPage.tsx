import { DoorOpen, Hash, Loader2, Lock, LogOut, Menu, MoreVertical, Phone, Settings2, UserPlus, Users, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";

import { GroupChat } from "@/components/chat/GroupChat";
import { MemberList } from "@/components/chat/MemberList";
import { GroupSettingsDialog } from "@/components/dialogs/GroupSettingsDialog";
import { InvitePeopleDialog } from "@/components/dialogs/InvitePeopleDialog";
import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { ServerRail } from "@/components/layout/ServerRail";
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
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCall } from "@/hooks/useCall";
import { useGroup } from "@/hooks/useGroup";
import { useGroupMembership, useJoinGroup, useLeaveGroup } from "@/hooks/useGroupMembership";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useRelayLivekitSupport } from "@/hooks/useLivekit";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { toast } from "@/hooks/useToast";
import { routeParamToRelay } from "@/lib/platform";
import { cn } from "@/lib/utils";

function JoinBanner({ relayUrl, groupId, isClosed }: { relayUrl: string; groupId: string; isClosed: boolean }) {
  const join = useJoinGroup(relayUrl, groupId);
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const [searchParams] = useSearchParams();
  const inviteCode = searchParams.get("code") ?? "";
  const [code, setCode] = useState(inviteCode);
  const autoJoined = useRef(false);

  const handleJoin = useCallback(async () => {
    try {
      await join.mutateAsync({ code: code.trim() || undefined });
      updateList({ action: "add", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({ title: "Join request sent", description: "The relay will admit you automatically or after review." });
    } catch (e) {
      toast({
        title: "Join failed",
        description: e instanceof Error ? e.message : "The relay rejected the request.",
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
    <div className="flex flex-wrap items-center gap-2 mx-2 mt-2 px-4 py-2.5 clip-corner-lg bg-black/30">
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
  const { data: details, isLoading } = useGroup(relayUrl, groupId);
  const { data: membership } = useGroupMembership(relayUrl, groupId);
  const { data: relayHasLivekit } = useRelayLivekitSupport(relayUrl);
  const leave = useLeaveGroup(relayUrl ?? "", groupId ?? "");
  const { removeUser, putUser } = useGroupModeration(relayUrl ?? "", groupId ?? "");
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { activeCall, joinCall } = useCall();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  /** Whether the desktop member roster is shown (toggled from the header). */
  const [membersVisible, setMembersVisible] = useState(true);
  const [channelsOpen, setChannelsOpen] = useState(false);
  /** Server whose channels are shown in the mobile drawer (defaults to current). */
  const [drawerServer, setDrawerServer] = useState(relayUrl ?? "");

  const isAdmin = useMemo(
    () => Boolean(user && details?.admins.some((a) => a.pubkey === user.pubkey)),
    [user, details?.admins],
  );

  if (!relayUrl || !groupId) {
    return <Navigate to="/" replace />;
  }

  const group = details?.group;
  // Admins may only appear in the kind 39001 admins list (e.g. the group
  // creator), not in 39002 members or via 9000 put-user events, so treat
  // admin status as membership too.
  const isMember =
    isAdmin || Boolean(membership?.isMember) || Boolean(user && details?.members.includes(user.pubkey));
  // NIP-29 relays generally only accept writes from members (relay29 always
  // does), so gate the composer on membership.
  const canWrite = Boolean(user) && isMember;
  // Voice is available when the group is tagged `livekit` or the relay
  // advertises the NIP-29 LiveKit extension for all its groups.
  const hasVoice = Boolean(group?.hasLivekit || relayHasLivekit);
  // Whether the active app-level call is this channel's room.
  const inThisCall = activeCall?.relayUrl === relayUrl && activeCall?.groupId === groupId;

  const handleLeave = async () => {
    try {
      await leave.mutateAsync({});
      updateList({ action: "remove", ref: { id: groupId, relay: relayUrl } }).catch(() => undefined);
      toast({ title: "Left channel" });
    } catch (e) {
      toast({
        title: "Leave failed",
        description: e instanceof Error ? e.message : "The relay rejected the request.",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      {/* Desktop panes (hidden on mobile — the chat is the full screen). */}
      <ServerRail className="hidden sidebar:flex" />
      <ChannelSidebar relayUrl={relayUrl} className="hidden sidebar:flex" />

      <main className="flex-1 min-w-0 flex flex-col safe-area-top">
        {/* Channel header — detached floating command bar, matching the right
            roster: same margin, cut-corner card, and recessed chrome shade. */}
        <header className="relative h-12 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-black/30">
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

          {group?.hasLivekit
            ? <Volume2 className="size-5 text-muted-foreground shrink-0" />
            : <Hash className="size-5 text-muted-foreground shrink-0" />}
          <div className="min-w-0 flex-1">
            <h1 className="font-semibold truncate leading-tight">
              {isLoading ? "…" : group?.name ?? groupId}
            </h1>
            {group?.about && (
              <p className="text-xs text-muted-foreground truncate">{group.about}</p>
            )}
          </div>
          {group?.isPrivate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock className="size-4 text-muted-foreground" aria-label="Private channel" />
              </TooltipTrigger>
              <TooltipContent>Private — only members can read</TooltipContent>
            </Tooltip>
          )}
          {hasVoice && !inThisCall && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Join voice"
                  className="size-8 text-muted-foreground hover:text-success"
                  onClick={() => joinCall(relayUrl, groupId)}
                >
                  <Phone className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Join voice</TooltipContent>
            </Tooltip>
          )}
          {/* Mobile members button → opens the member sheet. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Members"
            className="size-8 sidebar:hidden"
            onClick={() => setMembersOpen(true)}
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
                onClick={() => setMembersVisible((v) => !v)}
              >
                <Users className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{membersVisible ? "Hide members" : "Show members"}</TooltipContent>
          </Tooltip>
          {(isAdmin || (user && isMember)) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More options"
                  className="size-8 text-muted-foreground"
                >
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 p-1.5">
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
                  {group?.name ?? "Channel"}
                </DropdownMenuLabel>
                {isAdmin && (
                  <DropdownMenuItem className="gap-2.5 px-3 py-2" onClick={() => setInviteOpen(true)}>
                    <UserPlus className="size-4" />
                    Invite people
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <DropdownMenuItem className="py-2" onClick={() => setSettingsOpen(true)}>
                    <Settings2 className="size-4" />
                    Channel settings
                  </DropdownMenuItem>
                )}
                {user && isMember && (
                  <>
                    {isAdmin && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onClick={handleLeave}
                      disabled={leave.isPending}
                      className="py-2 text-destructive focus:text-destructive"
                    >
                      <LogOut className="size-4" />
                      Leave channel
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </header>

        {/* Join banner */}
        {user && !isMember && !isLoading && (
          <JoinBanner relayUrl={relayUrl} groupId={groupId} isClosed={Boolean(group?.isClosed)} />
        )}

        {/* The active voice call (if any) renders as a persistent docked bar in
            MainLayout, so it survives navigation between channels/servers. */}

        {/* Chat + members (member panel desktop-only; mobile uses the sheet) */}
        <div className="flex flex-1 min-h-0">
          <GroupChat
            relayUrl={relayUrl}
            groupId={groupId}
            canWrite={canWrite}
            canModerate={isAdmin}
          />
          <div
            className={cn(
              "shrink-0 overflow-hidden transition-[width] duration-200 ease-out",
              "w-0",
              membersVisible && "sidebar:w-[16.5rem]",
            )}
          >
            <div
              className={cn(
                "w-[16.5rem] h-full flex transition-transform duration-200 ease-out",
                membersVisible ? "translate-x-0" : "translate-x-full",
              )}
            >
              <MemberList
                admins={details?.admins ?? []}
                members={details?.members ?? []}
                canModerate={isAdmin}
                viewerIsAdmin={isAdmin}
                currentUserPubkey={user?.pubkey}
                onRemove={(pubkey) => removeUser.mutate({ pubkey })}
                onSetRole={(pubkey, roles) => putUser.mutate({ pubkey, roles })}
              />
            </div>
          </div>
        </div>
      </main>

      {/* Mobile channel list drawer (server rail + channels) */}
      <Sheet
        open={channelsOpen}
        onOpenChange={(open) => {
          setChannelsOpen(open);
          if (open) setDrawerServer(relayUrl);        }}
      >
        <SheetContent
          side="left"
          className="flex w-[min(20rem,85vw)] gap-0 p-0 sidebar:hidden [&>button]:hidden"
          aria-label="Channels"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex h-full w-full safe-area-top">
            <ServerRail
              selectedServer={drawerServer}
              onServerSelect={setDrawerServer}
            />
            <ChannelSidebar
              relayUrl={drawerServer}
              onNavigate={() => setChannelsOpen(false)}
              className="flex-1"
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile member sheet */}
      <Sheet open={membersOpen} onOpenChange={setMembersOpen}>
        <SheetContent
          side="right"
          className="w-[min(18rem,80vw)] p-0 sidebar:hidden [&>button]:hidden"
          aria-label="Members"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="h-full overflow-y-auto safe-area-top">
            <MemberList
              admins={details?.admins ?? []}
              members={details?.members ?? []}
              canModerate={isAdmin}
              viewerIsAdmin={isAdmin}
              currentUserPubkey={user?.pubkey}
              onRemove={(pubkey) => {
                removeUser.mutate({ pubkey });
                setMembersOpen(false);
              }}
              onSetRole={(pubkey, roles) => putUser.mutate({ pubkey, roles })}
              className="block w-full border-l-0"
            />
          </div>
        </SheetContent>
      </Sheet>

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
    </>
  );
}

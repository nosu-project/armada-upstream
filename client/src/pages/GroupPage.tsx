import { DoorOpen, Hash, Loader2, Lock, LogOut, Settings2, Volume2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";

import { GroupChat } from "@/components/chat/GroupChat";
import { MemberList } from "@/components/chat/MemberList";
import { VoiceBar } from "@/components/chat/VoiceBar";
import { GroupSettingsDialog } from "@/components/dialogs/GroupSettingsDialog";
import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroup } from "@/hooks/useGroup";
import { useGroupMembership, useJoinGroup, useLeaveGroup } from "@/hooks/useGroupMembership";
import { useGroupModeration } from "@/hooks/useGroupModeration";
import { useRelayLivekitSupport } from "@/hooks/useLivekit";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { toast } from "@/hooks/useToast";
import { routeParamToRelay } from "@/lib/platform";

function JoinBanner({ relayUrl, groupId, isClosed }: { relayUrl: string; groupId: string; isClosed: boolean }) {
  const join = useJoinGroup(relayUrl, groupId);
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const [code, setCode] = useState("");

  const handleJoin = async () => {
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
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b bg-primary/5">
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
  const { removeUser } = useGroupModeration(relayUrl ?? "", groupId ?? "");
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isAdmin = useMemo(
    () => Boolean(user && details?.admins.some((a) => a.pubkey === user.pubkey)),
    [user, details?.admins],
  );

  if (!relayUrl || !groupId) {
    return <Navigate to="/" replace />;
  }

  const group = details?.group;
  const isMember = Boolean(membership?.isMember) || Boolean(user && details?.members.includes(user.pubkey));
  // NIP-29 relays generally only accept writes from members (relay29 always
  // does), so gate the composer on membership.
  const canWrite = Boolean(user) && isMember;
  // Voice is available when the group is tagged `livekit` or the relay
  // advertises the NIP-29 LiveKit extension for all its groups.
  const hasVoice = Boolean(group?.hasLivekit || relayHasLivekit);

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
      <ChannelSidebar relayUrl={relayUrl} />

      <main className="flex-1 min-w-0 flex flex-col">
        {/* Channel header */}
        <header className="h-14 px-4 flex items-center gap-2 border-b shadow-sm shrink-0">
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
          {isAdmin && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Channel settings"
                  className="size-8"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Channel settings</TooltipContent>
            </Tooltip>
          )}
          {user && isMember && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Leave channel"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  onClick={handleLeave}
                  disabled={leave.isPending}
                >
                  <LogOut className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Leave channel</TooltipContent>
            </Tooltip>
          )}
        </header>

        {/* Join banner */}
        {user && !isMember && !isLoading && (
          <JoinBanner relayUrl={relayUrl} groupId={groupId} isClosed={Boolean(group?.isClosed)} />
        )}

        {/* Voice */}
        {hasVoice && <VoiceBar relayUrl={relayUrl} groupId={groupId} />}

        {/* Chat + members */}
        <div className="flex flex-1 min-h-0">
          <GroupChat
            relayUrl={relayUrl}
            groupId={groupId}
            canWrite={canWrite}
            canModerate={isAdmin}
          />
          <MemberList
            admins={details?.admins ?? []}
            members={details?.members ?? []}
            canModerate={isAdmin}
            onRemove={(pubkey) => removeUser.mutate({ pubkey })}
          />
        </div>
      </main>

      {group && (
        <GroupSettingsDialog
          relayUrl={relayUrl}
          group={group}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
    </>
  );
}

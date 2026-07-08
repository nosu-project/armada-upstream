import { Bell, BellOff, Hash, IdCard, Link2, MoreVertical, Trash2, Volume2 } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useState } from "react";

import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { ServerRail } from "@/components/layout/ServerRail";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { ServerProfileDialog } from "@/components/dialogs/ServerProfileDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { useMutes } from "@/hooks/useMutes";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { normalizeRelayUrl, PLATFORM_RELAYS, relayToRouteParam, routeParamToRelay } from "@/lib/platform";
import { writeClipboardText } from "@/lib/clipboard";
import { pickDefaultChannel } from "@/lib/utils";

/**
 * Server home (drill-down level 1). On mobile the server rail + channel list
 * fill the screen; the welcome/info pane only appears on desktop. Tapping a
 * channel pushes to the chat screen.
 */
export function ServerPage() {
  const { server } = useParams<{ server: string }>();
  const navigate = useNavigate();
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const relayUrl = server ? routeParamToRelay(server) : undefined;
  const [profileOpen, setProfileOpen] = useState(false);
  const { isCommunityMuted, toggleCommunityMute } = useMutes();
  const isDesktop = useIsDesktop();
  const serverMuted = Boolean(relayUrl && isCommunityMuted(relayUrl));

  const { data: groups, isLoading, isError, relayInfo } = useRelayGroups(relayUrl);

  if (!relayUrl) {
    return <Navigate to="/" replace />;
  }

  // Desktop (Discord-style): landing on a server opens the room you last had
  // open there (or a "general"/first channel), because the channel list stays
  // visible in the sidebar beside the chat — you never lose sight of it.
  //
  // Mobile is a single-pane drill-down: auto-diving into a channel would skip
  // the channel list entirely and drop you straight into chat. So on mobile we
  // stop here and show the channel list; tapping a channel opens the chat (and
  // backing out returns here). Only auto-redirect on desktop.
  //
  // Redirect SYNCHRONOUSLY (render a <Navigate replace>) the instant a default
  // channel is known — including on the very first render when `groups` is
  // already seeded from the IndexedDB cache. Doing this in render instead of a
  // post-paint `useEffect` avoids painting ServerPage's channel list first and
  // then swapping it for GroupPage. `replace` keeps the bare server URL out of
  // history.
  const defaultChannel =
    isDesktop && groups && groups.length > 0
      ? pickDefaultChannel(
          groups,
          config.lastChannelByServer[relayUrl],
          (g) => g.id,
          (g) => g.name,
        )
      : undefined;
  if (defaultChannel) {
    return (
      <Navigate
        to={`/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(defaultChannel.id)}`}
        replace
      />
    );
  }

  const isPinned = PLATFORM_RELAYS.includes(relayUrl);
  // A server is removable if it isn't a build-time pinned platform relay.
  // We compare by NORMALIZED url, not raw string equality: the stored
  // `addedRelays` entry may differ superficially from the route-derived url
  // (e.g. a trailing slash or casing off a kind-10009 `r` tag), which used to
  // hide "Remove server" for a server that's plainly in the rail. Any
  // non-pinned server the user can navigate to should be removable — including
  // one whose relay is now offline/shut down (removal is purely local).
  const isRemovable = !isPinned;

  const handleRemove = () => {
    updateConfig((current) => ({
      ...current,
      // Drop every stored entry that normalizes to this server, so a
      // trailing-slash/casing variant can't linger and re-add the rail icon.
      addedRelays: current.addedRelays.filter(
        (url) => normalizeRelayUrl(url) !== relayUrl,
      ),
    }));
    if (user && relayUrl) {
      updateList({ type: "remove-server", url: relayUrl }).catch((err) =>
        console.warn("Failed to sync server removal to group list:", err));
    }
    toast({ title: "Server removed", description: relayUrl });
    navigate("/");
  };

  const handleCopyLink = () => {
    if (!relayUrl) return;
    const link = `${window.location.origin}/s/${relayToRouteParam(relayUrl)}`;
    writeClipboardText(link).then(
      () => toast({ title: "Copied link" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  return (
    <ServerScopeProvider relayUrl={relayUrl}>
      <ServerRail />
      {/*
        Channel list. Desktop: a fixed-width sidebar next to the welcome pane.
        Mobile: it fills the screen and is where landing on a server stops (we
        no longer auto-dive into a channel on mobile), so show it right away —
        including its own loading skeleton — rather than a blank background.
      */}
      <ChannelSidebar
        relayUrl={relayUrl}
        className="flex-1 sidebar:flex-none"
      />

      {/* Welcome / server info pane — desktop only. */}
      <main className="hidden sidebar:block flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-8 space-y-6">
          <div className="flex items-start gap-4">
            <div className="flex size-16 items-center justify-center clip-corner-lg bg-primary/10 shrink-0 overflow-hidden">
              <img
                src={relayInfo?.icon || "/logo.svg"}
                alt={relayInfo?.name || "Armada"}
                className="size-16 object-cover"
              />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold truncate">
                {relayInfo?.name || relayUrl.replace(/^wss?:\/\//, "")}
              </h1>
              <p className="text-sm text-muted-foreground break-all">{relayUrl}</p>
              {relayInfo?.description && (
                <p className="mt-2 text-sm text-muted-foreground">{relayInfo.description}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {isPinned && <Badge variant="secondary">Pinned</Badge>}
                {relayInfo?.limitation?.auth_required && <Badge variant="secondary">NIP-42 AUTH</Badge>}
                {relayInfo?.supported_nips?.includes(29) && <Badge variant="secondary">NIP-29 groups</Badge>}
                {relayInfo?.software && (
                  <Badge variant="outline" className="max-w-48 truncate">
                    {relayInfo.software.split("/").pop()} {relayInfo.version}
                  </Badge>
                )}
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Server actions" className="size-8 text-muted-foreground hover:text-foreground shrink-0">
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 p-2">
                {user && (
                  <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={() => setProfileOpen(true)}>
                    <IdCard className="size-4" />
                    Server identity
                  </DropdownMenuItem>
                )}
                {user && (
                  <DropdownMenuItem
                    className="gap-3 px-3 py-2.5"
                    onClick={() => toggleCommunityMute(relayUrl)}
                  >
                    {serverMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                    {serverMuted ? "Unmute server" : "Mute server"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={handleCopyLink}>
                  <Link2 className="size-4" />
                  Copy link
                </DropdownMenuItem>
                {isRemovable && (
                  <DropdownMenuItem
                    className="gap-3 px-3 py-2.5 text-destructive focus:text-destructive"
                    onClick={handleRemove}
                  >
                    <Trash2 className="size-4" />
                    Remove server
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Channels
            </h2>
            {isLoading ? (
              <div className="grid sm:grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
              </div>
            ) : groups && groups.length > 0 ? (
              <div className="grid sm:grid-cols-2 gap-3">
                {groups.map((group) => (
                  <Card
                    key={group.id}
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => navigate(`/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(group.id)}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(group.id)}`);
                      }
                    }}
                  >
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-base">
                        {group.hasLivekit ? <Volume2 className="size-4 text-muted-foreground" /> : <Hash className="size-4 text-muted-foreground" />}
                        <span className="truncate">{group.name}</span>
                      </CardTitle>
                      {group.about && (
                        <CardDescription className="line-clamp-2">{group.about}</CardDescription>
                      )}
                    </CardHeader>
                    <CardContent className="pt-0 flex flex-wrap gap-1.5">
                      {group.isPrivate && <Badge variant="outline" className="text-[10px]">Members-only</Badge>}
                      {group.isClosed && <Badge variant="outline" className="text-[10px]">Invite-only</Badge>}
                      {group.hasLivekit && <Badge variant="outline" className="text-[10px]">Voice</Badge>}
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : isError && !groups ? (
              <Card className="border-dashed">
                <CardContent className="py-12 px-8 text-center">
                  <p className="text-muted-foreground max-w-sm mx-auto">
                    Couldn&rsquo;t reach this server. It may be offline or unreachable.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-dashed">
                <CardContent className="py-12 px-8 text-center">
                  <p className="text-muted-foreground max-w-sm mx-auto">
                    No channels on this server yet. Create one from the sidebar, or wait a
                    moment for the relay to respond.
                  </p>
                </CardContent>
              </Card>
            )}
          </section>
        </div>
      </main>

      {relayUrl && (
        <ServerProfileDialog
          relayUrl={relayUrl}
          open={profileOpen}
          onOpenChange={setProfileOpen}
        />
      )}
    </ServerScopeProvider>
  );
}

import { Hash, Trash2, Volume2 } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { ServerRail } from "@/components/layout/ServerRail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/hooks/useAppContext";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { toast } from "@/hooks/useToast";
import { PLATFORM_RELAYS, relayToRouteParam, routeParamToRelay } from "@/lib/platform";

/**
 * Server home (drill-down level 1). On mobile the server rail + channel list
 * fill the screen; the welcome/info pane only appears on desktop. Tapping a
 * channel pushes to the chat screen.
 */
export function ServerPage() {
  const { server } = useParams<{ server: string }>();
  const navigate = useNavigate();
  const { config, updateConfig } = useAppContext();
  const relayUrl = server ? routeParamToRelay(server) : undefined;

  const { data: groups, isLoading, relayInfo } = useRelayGroups(relayUrl);

  if (!relayUrl) {
    return <Navigate to="/" replace />;
  }

  const isPinned = PLATFORM_RELAYS.includes(relayUrl);
  const isAdded = config.addedRelays.includes(relayUrl);

  const handleRemove = () => {
    updateConfig((current) => ({
      ...current,
      addedRelays: current.addedRelays.filter((url) => url !== relayUrl),
    }));
    toast({ title: "Server removed", description: relayUrl });
    navigate("/");
  };

  return (
    <>
      <ServerRail />
      {/* Mobile: channel list fills the screen. Desktop: fixed-width sidebar. */}
      <ChannelSidebar relayUrl={relayUrl} className="flex-1 sidebar:flex-none" />

      {/* Welcome / server info pane — desktop only. */}
      <main className="hidden sidebar:block flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-8 space-y-6">
          <div className="flex items-start gap-4">
            <div className="flex size-16 items-center justify-center clip-corner-lg bg-primary/10 shrink-0 overflow-hidden">
              <img src="/logo.svg" alt="Armada" className="size-16" />
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
            {isAdded && (
              <Button variant="outline" size="sm" onClick={handleRemove}>
                <Trash2 className="size-3.5 mr-1.5" /> Remove
              </Button>
            )}
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
                    <CardContent className="pt-0 flex gap-1.5">
                      {group.isPrivate && <Badge variant="outline" className="text-[10px]">Private</Badge>}
                      {group.isClosed && <Badge variant="outline" className="text-[10px]">Invite-only</Badge>}
                      {group.hasLivekit && <Badge variant="outline" className="text-[10px]">Voice</Badge>}
                    </CardContent>
                  </Card>
                ))}
              </div>
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
    </>
  );
}

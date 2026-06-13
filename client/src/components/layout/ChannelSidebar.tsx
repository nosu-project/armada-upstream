import { Hash, Loader2, Lock, Plus, Volume2 } from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router-dom";

import { CreateGroupDialog } from "@/components/dialogs/CreateGroupDialog";
import { LoginArea } from "@/components/auth/LoginArea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";

import type { Nip29Group } from "@/lib/nip29";

function ChannelLink({ group }: { group: Nip29Group }) {
  const Icon = group.hasLivekit ? Volume2 : Hash;
  return (
    <NavLink
      to={`/s/${relayToRouteParam(group.relay)}/${encodeURIComponent(group.id)}`}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
          "text-muted-foreground hover:text-foreground hover:bg-accent",
          isActive && "bg-accent text-foreground font-medium",
        )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate flex-1">{group.name}</span>
      {group.isPrivate && <Lock className="size-3 shrink-0 opacity-60" aria-label="Private" />}
    </NavLink>
  );
}

interface ChannelSidebarProps {
  relayUrl: string;
}

/**
 * Channel list for a server: its NIP-29 groups, a create-channel action, and
 * the account area pinned to the bottom (Discord-style).
 */
export function ChannelSidebar({ relayUrl }: ChannelSidebarProps) {
  const { data: groups, isLoading, relayInfo } = useRelayGroups(relayUrl);
  const { user } = useCurrentUser();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <aside className="flex flex-col w-60 shrink-0 border-r bg-card/50">
      {/* Server header */}
      <div className="px-4 h-14 flex items-center border-b shadow-sm">
        <div className="min-w-0">
          <h2 className="font-semibold truncate leading-tight">
            {relayInfo?.name || relayUrl.replace(/^wss?:\/\//, "")}
          </h2>
          {relayInfo?.limitation?.auth_required && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">AUTH required</Badge>
          )}
        </div>
      </div>

      {/* Channels */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        <div className="flex items-center justify-between px-2 py-1">
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
          groups.map((group) => <ChannelLink key={group.id} group={group} />)
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

      {/* Account area */}
      <div className="border-t p-2">
        <LoginArea className="w-full flex" />
      </div>

      <CreateGroupDialog relayUrl={relayUrl} open={createOpen} onOpenChange={setCreateOpen} />
    </aside>
  );
}

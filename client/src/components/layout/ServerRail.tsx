import { Plus, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";

import { AddServerDialog } from "@/components/dialogs/AddServerDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/hooks/useAppContext";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { normalizeRelayUrl, PLATFORM_RELAYS, relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** Human-ish short name for a relay URL (hostname). */
function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ServerButton({ url }: { url: string }) {
  const { data: info } = useRelayInfo(url);
  const host = relayHost(url);
  const name = info?.name || host;
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          to={`/s/${relayToRouteParam(url)}`}
          aria-label={name}
          className={({ isActive }) =>
            cn(
              "group relative flex items-center justify-center",
              isActive && "is-active",
            )}
        >
          {({ isActive }) => (
            <>
              {/* Active pill indicator */}
              <span
                className={cn(
                  "absolute -left-2 w-1 rounded-r-full bg-foreground transition-all",
                  isActive ? "h-8" : "h-2 opacity-0 group-hover:opacity-100 group-hover:h-4",
                )}
              />
              <Avatar
                className={cn(
                  "size-12 transition-all rounded-3xl group-hover:rounded-2xl",
                  isActive && "rounded-2xl ring-2 ring-primary",
                )}
              >
                <AvatarImage src={info?.icon} alt={name} />
                <AvatarFallback className="bg-secondary text-secondary-foreground font-semibold">
                  {initial}
                </AvatarFallback>
              </Avatar>
            </>
          )}
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="right" className="font-medium">
        {name}
        <span className="block text-xs text-muted-foreground">{url}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Far-left vertical rail listing every server (relay): pinned platform
 * relays first, then user-added ones, then add-server and settings actions.
 */
export function ServerRail() {
  const { config } = useAppContext();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);

  const servers = useMemo(() => {
    const urls = new Set<string>(PLATFORM_RELAYS);
    for (const url of config.addedRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [config.addedRelays]);

  return (
    <nav
      aria-label="Servers"
      className="flex flex-col items-center gap-3 w-[72px] shrink-0 pt-1 pb-3 bg-background border-r overflow-y-auto"
    >
      {servers.map((url) => <ServerButton key={url} url={url} />)}

      <div className="w-8 border-t" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label="Add server"
            className="size-12 rounded-3xl hover:rounded-2xl transition-all text-success hover:bg-success hover:text-success-foreground"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Add a server</TooltipContent>
      </Tooltip>

      <div className="flex-1" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label="Settings"
            className="size-12 rounded-3xl hover:rounded-2xl transition-all"
            onClick={() => navigate("/settings")}
          >
            <Settings className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Settings</TooltipContent>
      </Tooltip>

      <AddServerDialog open={addOpen} onOpenChange={setAddOpen} />
    </nav>
  );
}

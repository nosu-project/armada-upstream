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

function ServerButton({ url, onNavigate }: { url: string; onNavigate?: () => void }) {
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
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "group relative flex items-center justify-center",
              isActive && "is-active",
            )}
        >
          {({ isActive }) => (
            <>
              {/* Active marker: a thin neon blade in the gutter. */}
              <span
                className={cn(
                  "absolute -left-2 w-[3px] bg-primary transition-all",
                  isActive ? "h-9 opacity-100" : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-4",
                )}
              />
              {/*
                Angular crest. Glow lives on the wrapper as a drop-shadow so it
                traces the fin silhouette (a box-shadow would be clipped away
                by the child's clip-path). Restrained: one soft shadow.
              */}
              <span
                className={cn(
                  "transition-all duration-150",
                  isActive
                    ? "[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]"
                    : "opacity-50 saturate-50 group-hover:opacity-100 group-hover:saturate-100",
                )}
              >
                <Avatar className="size-12 clip-corner-lg">
                  <AvatarImage src={info?.icon} alt={name} />
                  <AvatarFallback
                    className={cn(
                      "bg-secondary font-semibold",
                      isActive ? "text-primary" : "text-secondary-foreground",
                    )}
                  >
                    {initial}
                  </AvatarFallback>
                </Avatar>
              </span>
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
export function ServerRail({ onNavigate, className }: { onNavigate?: () => void; className?: string }) {
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
      className={cn(
        // Chrome plane — deepest part of the recessed frame.
        "flex flex-col items-center gap-3 w-[72px] shrink-0 pt-2 pb-3 overflow-y-auto bg-black/40",
        className,
      )}
    >
      {servers.map((url) => <ServerButton key={url} url={url} onNavigate={onNavigate} />)}

      <div className="w-7 h-px bg-white/10" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label="Add server"
            className="size-12 clip-corner-lg transition-all text-success hover:bg-success hover:text-success-foreground"
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
            className="size-12 clip-corner-lg transition-all"
            onClick={() => {
              onNavigate?.();
              navigate("/settings");
            }}
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

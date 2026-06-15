import { Headphones, MessageSquare, Plus, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";

import { AddServerDialog } from "@/components/dialogs/AddServerDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/hooks/useAppContext";
import { useCall } from "@/hooks/useCall";
import { useCurrentUser } from "@/hooks/useCurrentUser";
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

function ServerButton({
  url,
  onNavigate,
  onSelect,
  selected,
  inCall,
}: {
  url: string;
  onNavigate?: () => void;
  /** When provided, selecting a server fires this instead of navigating. */
  onSelect?: (url: string) => void;
  /** Active state when driven by `onSelect` (controlled mode). */
  selected?: boolean;
  /** Whether the active voice call is on this server. */
  inCall?: boolean;
}) {
  const { data: info } = useRelayInfo(url);
  const host = relayHost(url);
  const name = info?.name || host;
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  const inner = (isActive: boolean) => (
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
          "relative block size-12 transition-all duration-150",
          isActive && "[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
        )}
      >
        <Avatar
          className={cn(
            "size-12 clip-corner-lg transition-all duration-150",
            !isActive && "opacity-50 saturate-50 group-hover:opacity-100 group-hover:saturate-100",
          )}
        >
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
        {/* Voice indicator: a headphones badge when a call is live here. */}
        {inCall && (
          <span className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-background">
            <Headphones className="size-2.5" />
          </span>
        )}
      </span>
    </>
  );

  const triggerClass = "group relative flex items-center justify-center";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onSelect ? (
          <button
            type="button"
            aria-label={name}
            onClick={() => onSelect(url)}
            className={cn(triggerClass, selected && "is-active")}
          >
            {inner(Boolean(selected))}
          </button>
        ) : (
          <NavLink
            to={`/s/${relayToRouteParam(url)}`}
            aria-label={name}
            onClick={onNavigate}
            className={({ isActive }) => cn(triggerClass, isActive && "is-active")}
          >
            {({ isActive }) => inner(isActive)}
          </NavLink>
        )}
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
export function ServerRail({
  onNavigate,
  onServerSelect,
  selectedServer,
  className,
}: {
  onNavigate?: () => void;
  /** When set, tapping a server fires this instead of navigating (drawer mode). */
  onServerSelect?: (url: string) => void;
  /** The currently-selected server in drawer mode. */
  selectedServer?: string;
  className?: string;
}) {
  const { config } = useAppContext();
  const navigate = useNavigate();
  const { activeCall } = useCall();
  const { user } = useCurrentUser();
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
        "flex flex-col items-center gap-5 w-[72px] shrink-0 pt-3 pb-3 overflow-y-auto bg-chrome-deep",
        className,
      )}
    >
      {/* Direct messages — account-level, above the servers (Discord-style).
          Only shown when signed in (DMs require an account). */}
      {user && (
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to="/dms"
              aria-label="Direct messages"
              onClick={onNavigate}
              className="group relative flex items-center justify-center"
            >
              <span
                className={cn(
                  "relative block size-12 transition-all duration-150",
                  "group-aria-[current=page]:[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                )}
              >
                <span
                  className={cn(
                    "flex items-center justify-center size-12 clip-corner-lg transition-all duration-150",
                    "bg-muted text-primary opacity-50 saturate-50",
                    "group-hover:opacity-100 group-hover:saturate-100",
                    "group-aria-[current=page]:opacity-100 group-aria-[current=page]:saturate-100",
                  )}
                >
                  <MessageSquare className="size-5" />
                </span>
              </span>
            </NavLink>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            Direct messages
          </TooltipContent>
        </Tooltip>
      )}

      {servers.map((url) => (
        <ServerButton
          key={url}
          url={url}
          onNavigate={onNavigate}
          onSelect={onServerSelect}
          selected={onServerSelect ? selectedServer === url : undefined}
          inCall={activeCall?.relayUrl === url}
        />
      ))}

      <div className="w-7 h-px bg-chrome-divider" />

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

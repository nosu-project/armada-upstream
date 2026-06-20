import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

interface ChannelSidebarViewProps {
  /** Primary title (server name / community name). */
  title: ReactNode;
  /** Secondary line under the title (relay host, "End-to-end encrypted", …). */
  subtitle?: ReactNode;
  /** Optional leading icon before the title (e.g. a shield for Concord). */
  titleIcon?: ReactNode;
  /** Optional badge shown under the header (e.g. "AUTH required"). */
  badge?: ReactNode;
  /** Tooltip/label for the add-channel action. Action hidden when omitted. */
  addChannelLabel?: string;
  onAddChannel?: () => void;
  /**
   * Inline content under the "Channels" label (e.g. a create-channel form).
   * Concord renders its add form here; NIP-29 leaves it empty (it uses a dialog).
   */
  channelsHeaderExtra?: ReactNode;
  /** The channel rows (NavLinks for NIP-29, selection buttons for Concord). */
  children: ReactNode;
  /** Pinned footer (NIP-29: the persistent call-bar slot + account area). */
  footer?: ReactNode;
  className?: string;
}

/**
 * Presentational channel-list shell shared by the NIP-29 `ChannelSidebar` and
 * Concord's community page: the recessed chrome plane, the server/community
 * header, the "Channels" section label + add action, the scrollable row list
 * and an optional pinned footer. The actual channel rows and data come from the
 * caller, so the two transports render an identical frame.
 */
export function ChannelSidebarView({
  title,
  subtitle,
  titleIcon,
  badge,
  addChannelLabel,
  onAddChannel,
  channelsHeaderExtra,
  children,
  footer,
  className,
}: ChannelSidebarViewProps) {
  const addButton = onAddChannel && (
    <Button
      variant="ghost"
      size="icon"
      className="size-5"
      aria-label={addChannelLabel ?? "Add channel"}
      onClick={onAddChannel}
    >
      <Plus className="size-4" />
    </Button>
  );

  return (
    <aside
      className={cn(
        // Chrome plane — recessed, darker than the deck, identical to the rail,
        // header and roster so they read as one frame around the bright chat.
        "relative flex flex-col w-60 shrink-0 bg-chrome",
        className,
      )}
    >
      {/* Header — aligned with the channel rows' text gutter below (container
          px-1 + row pl-4 = pl-5 here) so the grid lines up. */}
      <div className={cn("pl-5 pr-3 pt-5 pb-3 flex", titleIcon ? "items-center gap-2" : "flex-col justify-center")}>
        {titleIcon}
        <div className="min-w-0">
          <h2 className="font-semibold truncate leading-tight tracking-wide text-sm">{title}</h2>
          {subtitle && (
            <span className="block text-[11px] text-muted-foreground truncate leading-tight">{subtitle}</span>
          )}
          {badge}
        </div>
      </div>

      {/* Divider between the header and the channel list. */}
      <div className="mx-3 h-0.5 shrink-0 bg-chrome-divider" />

      {/* Channels */}
      <div className="flex-1 overflow-y-auto px-1 pt-[11px] pb-2 space-y-0.5">
        <div className="flex items-center justify-between pl-4 pr-2 py-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Channels
          </span>
          {addChannelLabel ? (
            <Tooltip>
              <TooltipTrigger asChild>{addButton}</TooltipTrigger>
              <TooltipContent>{addChannelLabel}</TooltipContent>
            </Tooltip>
          ) : (
            addButton
          )}
        </div>

        {channelsHeaderExtra}
        {children}
      </div>

      {footer}
    </aside>
  );
}

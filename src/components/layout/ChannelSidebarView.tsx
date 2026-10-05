import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

interface ChannelSidebarViewProps {
  title: ReactNode;
  subtitle?: ReactNode;
  titleIcon?: ReactNode;
  /**
   * Inline panel below the header (Concord's community menu): a
   * `CollapsibleContent` triggered by `title`, pushing the list down rather than floating.
   */
  titleExpansion?: ReactNode;
  banner?: ReactNode;
  badge?: ReactNode;
  /** Label for the add-channel action; hidden when omitted. */
  addChannelLabel?: string;
  onAddChannel?: () => void;
  addChannelOpen?: boolean;
  /** Disabled "+" placeholder so headers without an add action (e.g. Mesh) line up. */
  addChannelDisabled?: boolean;
  /** Section above the "Channels" label (e.g. Concord's Mentions/Threads). */
  preChannels?: ReactNode;
  /** Sections below "Channels"; each child should be its own `<div className="space-y-0.5">`. */
  postChannels?: ReactNode;
  channelsHeaderExtra?: ReactNode;
  children: ReactNode;
  scrollRef?: React.Ref<HTMLDivElement>;
  footer?: ReactNode;
  className?: string;
}

/** Presentational channel-list shell shared by NIP-29 `ChannelSidebar` and Concord's community page. */
export function ChannelSidebarView({
  title,
  subtitle,
  titleIcon,
  titleExpansion,
  banner,
  badge,
  addChannelLabel,
  onAddChannel,
  addChannelOpen,
  addChannelDisabled,
  preChannels,
  postChannels,
  channelsHeaderExtra,
  children,
  footer,
  className,
  scrollRef,
}: ChannelSidebarViewProps) {
  const addLabel = addChannelOpen ? "Cancel" : addChannelLabel;
  const addButton = (onAddChannel || addChannelDisabled) && (
    <Button
      variant="ghost"
      size="icon"
      className="size-5 touch:size-8"
      aria-label={addLabel ?? "Add channel"}
      aria-expanded={addChannelOpen}
      onClick={onAddChannel}
      disabled={!onAddChannel}
    >
      <Plus className={cn("size-4 transition-transform duration-200", addChannelOpen && "rotate-45")} />
    </Button>
  );

  return (
    <aside
      className={cn(
        "relative flex flex-col w-60 shrink-0 bg-chrome",
        className,
      )}
    >
      {/* Header is exactly 60px on desktop so the divider lines up with the rail's
          first icon and the chat header card. On mobile a banner fills this block as
          a background so the layout doesn't jump between servers with and without one. */}
      <div
        className={cn(
          "relative pl-3 pr-3 pb-[1.625rem] flex",
          "pt-[calc(1.5rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
          // Same alignment with or without a banner; the mobile banner is absolute.
          titleIcon ? "items-center gap-1" : "flex-col justify-center",
        )}
      >
        {banner && (
          <>
            <div className="sidebar:hidden absolute inset-0 overflow-hidden">{banner}</div>
            {/* Darkens the status-bar inset so light status icons stay legible over bright banners. */}
            <div
              aria-hidden
              className="sidebar:hidden absolute inset-x-0 top-0 h-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+0.5rem)] pointer-events-none bg-gradient-to-b from-[hsl(var(--chrome))] via-[hsl(var(--chrome)/0.7)] to-transparent"
            />
            <div
              aria-hidden
              className="sidebar:hidden absolute inset-x-0 bottom-0 h-2/3 pointer-events-none bg-gradient-to-t from-[hsl(var(--chrome))] via-[hsl(var(--chrome)/0.7)] to-transparent"
            />
          </>
        )}
        {titleIcon && <div className="relative shrink-0">{titleIcon}</div>}
        <div className="relative min-w-0">
          {/* Reserve the 24px icon line height so text-only titles align identically. */}
          <div className="flex items-center min-h-6">
            <h2 className="min-w-0 font-semibold truncate leading-tight tracking-wide text-sm">{title}</h2>
          </div>
          {subtitle && (
            <span className="block text-2xs text-muted-foreground truncate leading-tight">{subtitle}</span>
          )}
          {badge}
        </div>
      </div>

      {titleExpansion}

      {banner && <div className="hidden sidebar:block h-20 shrink-0 overflow-hidden">{banner}</div>}

      <div className="mx-3 h-0.5 shrink-0 bg-chrome-divider" />

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-1 pt-[11px] pb-2 flex flex-col gap-5">
        {preChannels && <div className="space-y-0.5">{preChannels}</div>}

        <div className="space-y-0.5">
          <div className="flex items-center justify-between pl-4 pr-2 py-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Channels
            </span>
            {addLabel ? (
              <Tooltip>
                <TooltipTrigger asChild>{addButton}</TooltipTrigger>
                <TooltipContent>{addLabel}</TooltipContent>
              </Tooltip>
            ) : (
              addButton
            )}
          </div>

          {channelsHeaderExtra}
          {children}
        </div>

        {postChannels}
      </div>

      {footer}
    </aside>
  );
}

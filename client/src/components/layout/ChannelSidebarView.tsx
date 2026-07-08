import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

interface ChannelSidebarViewProps {
  /** Primary title (server name / community name). */
  title: ReactNode;
  /** Secondary line under the title (relay host, protocol note, …). */
  subtitle?: ReactNode;
  /** Optional leading icon before the title (e.g. a shield for Concord). */
  titleIcon?: ReactNode;
  /** Optional full-width banner image rendered above the header (Concord). */
  banner?: ReactNode;
  /** Optional badge shown under the header (e.g. "AUTH required"). */
  badge?: ReactNode;
  /** Tooltip/label for the add-channel action. Action hidden when omitted. */
  addChannelLabel?: string;
  onAddChannel?: () => void;
  /**
   * Whether the inline add-channel form is open. While open the "+" rotates
   * into an "×" (45°, animated) and the action reads as Cancel.
   */
  addChannelOpen?: boolean;
  /**
   * Render the add-channel "+" as a disabled placeholder (no action yet). Keeps
   * the "Channels" header row at the same height as transports that do have an
   * add action, so sidebars without one (e.g. Mesh) line up identically.
   */
  addChannelDisabled?: boolean;
  /**
   * Content rendered ABOVE the "Channels" section label (e.g. Concord's
   * "@ Mentions" nav item). Sits at the top of the scroll region.
   */
  preChannels?: ReactNode;
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
  banner,
  badge,
  addChannelLabel,
  onAddChannel,
  addChannelOpen,
  addChannelDisabled,
  preChannels,
  channelsHeaderExtra,
  children,
  footer,
  className,
}: ChannelSidebarViewProps) {
  const addLabel = addChannelOpen ? "Cancel" : addChannelLabel;
  const addButton = (onAddChannel || addChannelDisabled) && (
    <Button
      variant="ghost"
      size="icon"
      className="size-5"
      aria-label={addLabel ?? "Add channel"}
      aria-expanded={addChannelOpen}
      onClick={onAddChannel}
      disabled={!onAddChannel}
    >
      {/* A Plus rotated 45° IS an ×: one glyph, animated between the states. */}
      <Plus className={cn("size-4 transition-transform duration-200", addChannelOpen && "rotate-45")} />
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
      {/* Desktop: the banner is its own block above the header (the sidebar is
          a persistent column that doesn't touch the top screen edge). */}
      {banner && <div className="hidden sidebar:block h-20 shrink-0 overflow-hidden">{banner}</div>}
      {/* Header — aligned with the channel rows' text gutter below (container
          px-1 + row pl-4 = pl-5 here) so the grid lines up. The header reaches
          the top screen edge on mobile, so it carries the status-bar safe-area
          inset on top of its base top padding (0 on desktop).

          On MOBILE a community banner (when present) fills this header block as
          its BACKGROUND — from the top screen edge down to the divider below —
          so the divider, title and "Channels" sub-header keep the exact same
          position whether or not a server/community has a banner. That keeps
          the layout from jumping vertically as you navigate between them. The
          title sits at the bottom over a scrim so it stays legible on top of
          any image. On desktop the banner is a separate block above (see
          above), so the header behaves normally. */}
      <div
        className={cn(
          "relative pl-5 pr-3 pb-3 flex",
          "pt-[calc(1.25rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
          // Alignment is IDENTICAL with or without a banner so the title (and
          // therefore the divider + Channels section below) sits at the exact
          // same vertical position — the mobile banner is a pure absolute
          // background that doesn't participate in flow or alignment, so it can
          // never nudge the header down.
          titleIcon ? "items-center gap-2" : "flex-col justify-center",
        )}
      >
        {/* Mobile-only banner background (desktop uses the block above). These
            layers are absolutely positioned, so they don't affect the header's
            height or the title's alignment. */}
        {banner && (
          <>
            <div className="sidebar:hidden absolute inset-0 overflow-hidden">{banner}</div>
            {/* Bottom-anchored scrim so the title reads on any banner. */}
            <div
              aria-hidden
              className="sidebar:hidden absolute inset-x-0 bottom-0 h-2/3 pointer-events-none bg-gradient-to-t from-[hsl(var(--chrome))] via-[hsl(var(--chrome)/0.7)] to-transparent"
            />
          </>
        )}
        {titleIcon && <div className="relative shrink-0">{titleIcon}</div>}
        <div className="relative min-w-0">
          {/* Reserve a constant primary-line height (= the size-5 title
              icon/avatar) so the header block — and therefore the divider and
              Channels section below — sits at the exact same vertical position
              whether or not the community/server has an icon. Without this
              floor, an icon (taller than the text line) grows the header and
              pushes everything down. The h2 stays block so `truncate` works;
              the flex wrapper only vertically centers it in the reserved line. */}
          <div className="flex items-center min-h-5">
            <h2 className="min-w-0 font-semibold truncate leading-tight tracking-wide text-sm">{title}</h2>
          </div>
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
        {preChannels}
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

      {footer}
    </aside>
  );
}

import { ChevronDown, FolderMinus, Pencil } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

interface ChannelCategoryHeading2Props {
  name: string;
  collapsed: boolean;
  onToggle: () => void;
  /**
   * Unread inside a collapsed category. Rendered as a dot on the heading so
   * collapsing a category never hides the fact that something happened in it.
   */
  hasUnread?: boolean;
  /**
   * Re-file every channel in the category under a new name. A category has no
   * id, so this is the only thing "rename" can mean — and why it belongs here
   * rather than as a per-channel edit repeated by hand.
   *
   * Undefined for a member without MANAGE_CHANNELS: no menu at all.
   */
  onRename?: () => void;
  /** Clear the category from every channel in it, dissolving the heading. */
  onUngroup?: () => void;
  children?: React.ReactNode;
}

/** A collapsible category heading in the channel sidebar. */
export function ChannelCategoryHeading2({
  name,
  collapsed,
  onToggle,
  hasUnread,
  onRename,
  onUngroup,
  children,
}: ChannelCategoryHeading2Props) {
  const heading = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      // The dense desktop heading is ~28px tall; on touch the tap target grows
      // to the 44px floor without moving the text (extra padding, same type).
      className="flex w-full items-center gap-1 px-2 pt-3 pb-0.5 touch:pt-4 touch:pb-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80 transition-colors hover:text-foreground"
    >
      <ChevronDown
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
      />
      <span className="truncate">{name}</span>
      {/* Only meaningful while collapsed — expanded, the channel rows say it. */}
      {collapsed && hasUnread && (
        <span className="ml-1 size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />
      )}
      {children}
    </button>
  );

  if (!onRename && !onUngroup) return heading;
  return (
    <ContextMenu>
      {/* Right-click on a pointer device, press-and-hold on touch — Radix
          drives both, so the heading needs no gesture handling of its own. */}
      <ContextMenuTrigger asChild>{heading}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {onRename && (
          <ContextMenuItem onSelect={onRename}>
            <Pencil className="mr-2 size-4" />
            Rename category
          </ContextMenuItem>
        )}
        {onUngroup && (
          <ContextMenuItem onSelect={onUngroup}>
            <FolderMinus className="mr-2 size-4" />
            Ungroup channels
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

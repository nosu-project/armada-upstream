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
  /** Dot on the heading so collapsing never hides unread. */
  hasUnread?: boolean;
  /** Re-file every channel under a new name (categories have no id). Undefined without MANAGE_CHANNELS. */
  onRename?: () => void;
  onUngroup?: () => void;
  /** A drag is aimed inside this category. */
  highlight?: boolean;
  children?: React.ReactNode;
}

export function ChannelCategoryHeading({
  name,
  collapsed,
  onToggle,
  hasUnread,
  onRename,
  onUngroup,
  highlight,
  children,
}: ChannelCategoryHeading2Props) {
  const heading = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      // Touch grows the tap target to 44px without moving the text.
      className={cn(
        "flex w-full items-center gap-1 px-2 pt-3 pb-0.5 touch:pt-4 touch:pb-2.5 text-left text-2xs font-semibold uppercase tracking-wider transition-colors",
        highlight ? "text-primary" : "text-muted-foreground/80 hover:text-foreground",
      )}
    >
      <ChevronDown
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
      />
      <span className="truncate">{name}</span>
      {collapsed && hasUnread && (
        <span className="ml-1 size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />
      )}
      {children}
    </button>
  );

  if (!onRename && !onUngroup) return heading;
  return (
    <ContextMenu>
      {/* Radix handles both right-click and press-and-hold. */}
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

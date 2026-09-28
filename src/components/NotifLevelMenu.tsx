import { Bell, BellOff, AtSign } from "lucide-react";

import {
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";

import type { NotifLevel } from "@/hooks/useNotifLevels";

/**
 * Per-conversation notification level submenu; applies to every delivery path
 * via `useNotifLevels`. `level` is the RESOLVED level (channel → community →
 * global), and selecting always writes an explicit override.
 */
export function NotifLevelMenu(props: {
  label?: string;
  level: NotifLevel;
  onChange: (level: NotifLevel) => void;
}) {
  const { label = "Notifications", level, onChange } = props;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        {level === "nothing" ? (
          <BellOff className="mr-2 size-4" />
        ) : level === "mentions" ? (
          <AtSign className="mr-2 size-4" />
        ) : (
          <Bell className="mr-2 size-4" />
        )}
        {label}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-48">
        <ContextMenuRadioGroup value={level} onValueChange={(v) => onChange(v as NotifLevel)}>
          <ContextMenuRadioItem value="all">
            <Bell className="mr-2 size-4" /> All messages
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="mentions">
            <AtSign className="mr-2 size-4" /> Only @mentions
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="nothing">
            <BellOff className="mr-2 size-4" /> Nothing
          </ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

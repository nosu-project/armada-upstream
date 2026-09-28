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
 * Discord-style per-conversation notification-level picker, rendered as a
 * context-menu submenu (All messages / Only @mentions / Nothing). Applies
 * to EVERY delivery path — foreground toasts/OS notifications, the Android
 * persistent service, and Web Push — because all of them read the resolved
 * level from `useNotifLevels`.
 *
 * `level` is the currently RESOLVED level (after the channel → community →
 * global cascade), so the active row reflects what actually happens even when
 * the value is inherited. Selecting a row writes an explicit override for this
 * scope; selecting the row that already matches an inherited value still writes
 * the override (harmless, and makes the choice sticky).
 */
export function NotifLevelMenu(props: {
  /** Menu label, e.g. "Notifications" or "Channel notifications". */
  label?: string;
  /** The resolved level to reflect as selected. */
  level: NotifLevel;
  /** Called with the chosen level. */
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

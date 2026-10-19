import { Bell, BellOff, AtSign } from "lucide-react";

import {
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";

import { FormattedMessage, useIntl } from "@/i18n";

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
  const intl = useIntl();
  const { level, onChange } = props;
  const label = props.label ?? intl.formatMessage({ id: "notifLevelMenu.label", defaultMessage: "Notifications" });
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
            <Bell className="mr-2 size-4" /> <FormattedMessage id="notifLevelMenu.all" defaultMessage="All messages" />
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="mentions">
            <AtSign className="mr-2 size-4" /> <FormattedMessage id="notifLevelMenu.mentions" defaultMessage="Only @mentions" />
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="nothing">
            <BellOff className="mr-2 size-4" /> <FormattedMessage id="notifLevelMenu.nothing" defaultMessage="Nothing" />
          </ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

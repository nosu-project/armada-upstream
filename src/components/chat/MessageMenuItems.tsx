import { ModerationMenuSection } from "@/components/chat/ModerationMenuSection";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

import type { MessageActionItem } from "@/components/chat/messageActions";

const PARTS = {
  Item: DropdownMenuItem,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

function ActionItem({ action }: { action: MessageActionItem }) {
  return (
    <DropdownMenuItem
      disabled={action.disabled}
      className={action.destructive ? "text-destructive focus:text-destructive" : undefined}
      onSelect={action.onSelect}
    >
      <action.icon className="size-4" />
      {action.label}
    </DropdownMenuItem>
  );
}

/** A message's actions as dropdown rows, with moderation behind its own section. */
export function MessageMenuItems({ actions }: { actions: MessageActionItem[] }) {
  const main = actions.filter((a) => !a.moderation);
  const moderation = actions.filter((a) => a.moderation);
  return (
    <>
      {main.map((action, i) => (
        <div key={action.id}>
          {action.groupStart && i > 0 && <DropdownMenuSeparator />}
          <ActionItem action={action} />
        </div>
      ))}
      {moderation.length > 0 && (
        <>
          {main.length > 0 && <DropdownMenuSeparator />}
          <ModerationMenuSection parts={PARTS}>
            {moderation.map((action) => (
              <ActionItem key={action.id} action={action} />
            ))}
          </ModerationMenuSection>
        </>
      )}
    </>
  );
}

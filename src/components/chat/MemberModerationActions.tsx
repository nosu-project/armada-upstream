import { ChevronDown, UserCog } from "lucide-react";

import { RolePickerItems } from "@/components/chat/RolePickerItems";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMemberActions, useMemberRolePicker } from "@/hooks/useMemberActions";
import { cn } from "@/lib/utils";

/**
 * The moderation footer of a person surface: what the viewer may do to this
 * member, right where they clicked them.
 *
 * Renders nothing at all for the overwhelming majority of viewers — anyone
 * who isn't staff, and staff looking at someone they don't outrank — so the
 * card it sits in is unchanged for them. Staff get the actions without having
 * to find the person a second time in the member list, which is the whole
 * point of it living here rather than only on a roster row.
 *
 * Buttons rather than another overflow menu: on a touch device the person is
 * already two taps away (avatar, then the action), and a third tap into a
 * 32px `⋯` inside a popover is exactly the friction this is meant to remove.
 * They are safe to surface that directly because every destructive one opens
 * a confirmation dialog rather than acting on click — see the provider.
 *
 * Roles are the one menu here: they are a checklist, not an action, and the
 * same rows the member list's ⋮ → Roles submenu renders. Toggling one leaves
 * the card open, so the role chips above update in place. The owner may
 * assign themselves a cosmetic role, so this can render on their own card
 * with a "Roles" heading and no moderation.
 */
export function MemberModerationActions({
  pubkey,
  onAction,
  className,
}: {
  pubkey: string;
  /** Called before the action runs, e.g. to close the surrounding popover. */
  onAction?: () => void;
  className?: string;
}) {
  const actions = useMemberActions(pubkey);
  const rolePicker = useMemberRolePicker(pubkey);
  if (actions.length === 0 && !rolePicker) return null;

  return (
    <div className={cn("border-t border-border/60 pt-3", className)}>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
        {actions.length > 0 ? "Moderation" : "Roles"}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {rolePicker && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" className="h-9 min-w-24 flex-1 clip-corner-lg touch:h-11">
                <UserCog className="size-3.5 mr-1.5" />
                <span className="truncate">Roles</span>
                <ChevronDown className="size-3.5 ml-1 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 max-h-72 overflow-y-auto p-1.5">
              <RolePickerItems
                CheckboxItem={DropdownMenuCheckboxItem}
                pubkey={pubkey}
                catalog={rolePicker.catalog}
                heldRoleIds={rolePicker.heldRoleIds}
                isToggling={rolePicker.isToggling}
                onToggle={rolePicker.onToggle}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {actions.map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant="secondary"
            // Grows to the touch minimum rather than matching the card's other
            // h-8 rows: these are the actions where a mis-tap costs something.
            // A destructive one is a red-tinted fill, not a border.
            className={cn(
              "h-9 min-w-24 flex-1 clip-corner-lg touch:h-11",
              action.destructive &&
                "bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive",
            )}
            onClick={() => {
              onAction?.();
              action.onSelect();
            }}
          >
            <action.icon className="size-3.5 mr-1.5" />
            <span className="truncate">{action.label}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

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
 * Moderation footer on a person surface; renders nothing unless the viewer is
 * staff who outranks the member. Plain buttons (not a menu) since destructive
 * ones confirm first. Roles is a checklist menu; the owner may assign
 * themselves cosmetic roles here.
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
      <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground/80">
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
            // Touch-minimum height: a mis-tap here costs something.
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

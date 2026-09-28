import type { ComponentType, ReactNode } from "react";

/** A grantable role in a per-member "Roles" picker (Concord custom roles). */
export interface RolePickerOption {
  id: string;
  name: string;
  /** Cosmetic badge tint (low 24 bits an #rrggbb); 0 = theme default. */
  color: number;
  /**
   * Set when the role is channel-scoped — rendered as a "# channel" hint.
   * `null` when that channel has since been deleted: still channel-scoped, but
   * a picker names no channel that no longer exists.
   */
  channelName?: string | null;
  /** Whether the viewer outranks this role's position (may grant/revoke it). */
  assignable: boolean;
}

/** Radix's DropdownMenu and ContextMenu checkbox items share these props. */
export type RoleCheckboxItem = ComponentType<{
  className?: string;
  checked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  onSelect?: (e: Event) => void;
  children?: ReactNode;
}>;

const roleTint = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;

/**
 * The checkbox rows of a member's role picker, rendered through whichever menu
 * family hosts them — the member row's ⋮ and right-click submenus, and the
 * profile card's Roles menu — so the gating and the toggle guard live once.
 */
export function RolePickerItems({
  CheckboxItem,
  pubkey,
  catalog,
  heldRoleIds,
  isToggling,
  onToggle,
}: {
  CheckboxItem: RoleCheckboxItem;
  pubkey: string;
  catalog: RolePickerOption[];
  heldRoleIds?: string[];
  isToggling?: (pubkey: string, roleId: string) => boolean;
  onToggle: (pubkey: string, roleId: string, on: boolean) => void;
}) {
  return (
    <>
      {catalog.map((role) => (
        <CheckboxItem
          key={role.id}
          className="py-2"
          checked={heldRoleIds?.includes(role.id) ?? false}
          // A Grant replaces the member's whole role list, so a
          // second click before the first lands would publish from a
          // stale set and re-trigger any gated-channel rotation.
          disabled={!role.assignable || Boolean(isToggling?.(pubkey, role.id))}
          onCheckedChange={(on) => onToggle(pubkey, role.id, on)}
          // Keep the menu open so several roles can be toggled in one visit.
          onSelect={(e) => e.preventDefault()}
        >
          <span className="min-w-0 flex-1 truncate text-sm" style={role.color ? { color: roleTint(role.color) } : undefined}>
            {role.name}
          </span>
          {role.channelName && (
            <span className="ml-2 shrink-0 text-[11px] text-muted-foreground truncate max-w-24"># {role.channelName}</span>
          )}
        </CheckboxItem>
      ))}
    </>
  );
}

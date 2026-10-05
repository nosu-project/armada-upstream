import type { LucideIcon } from "lucide-react";
import { createContext } from "react";

import type { RolePickerOption } from "@/components/chat/RolePickerItems";

/**
 * What the VIEWER may do to one member of the current community, for shared
 * surfaces like {@link ProfilePreviewCard} (which takes only a pubkey). Sibling
 * of {@link MemberRolesContext}; unprovided scopes (DMs) show nothing. Holds
 * FINISHED actions so each backend keeps its vocabulary. Affordances only — the
 * mutation re-checks authority.
 */
export interface MemberActionItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Rendered in the destructive style and, by convention, listed last. */
  destructive?: boolean;
  disabled?: boolean;
  /** Ask first, saying what changes. Every surface honours it via `useUserModeration`. */
  confirm?: MemberActionConfirm;
  onSelect: () => void;
}

export interface MemberActionConfirm {
  title: string;
  /** What the change does and who can undo it. */
  consequences: string[];
  confirmLabel: string;
  icon: LucideIcon;
}

export interface MemberActionsValue {
  /** This viewer's actions against this member; empty when none (the common case). */
  actionsFor: (pubkey: string) => MemberActionItem[];
  /** The role picker (a checklist toggled in place), or undefined if no role is changeable. */
  rolePickerFor?: (pubkey: string) => MemberRolePicker | undefined;
}

export interface MemberRolePicker {
  /** Every role, display-ordered; ones the viewer doesn't outrank are disabled. */
  catalog: RolePickerOption[];
  /** The roles this member holds, as this client last asked for them. */
  heldRoleIds: string[];
  isToggling: (pubkey: string, roleId: string) => boolean;
  onToggle: (pubkey: string, roleId: string, on: boolean) => void;
}

export const MemberActionsContext = createContext<MemberActionsValue | undefined>(undefined);

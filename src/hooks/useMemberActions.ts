import { useContext } from "react";

import { MemberActionsContext, type MemberActionItem, type MemberRolePicker } from "@/contexts/MemberActionsContext";

/**
 * The moderation actions the viewer may take against one member, or an empty
 * list outside a community that offers any. Never throws for a missing
 * provider — a shared surface must render identically without one.
 */
export function useMemberActions(pubkey: string | undefined): MemberActionItem[] {
  const ctx = useContext(MemberActionsContext);
  if (!ctx || !pubkey) return EMPTY;
  return ctx.actionsFor(pubkey);
}

const EMPTY: MemberActionItem[] = [];

/**
 * The role picker the viewer may use on one member, or undefined — outside a
 * community, or for a member whose roles they cannot change.
 */
export function useMemberRolePicker(pubkey: string | undefined): MemberRolePicker | undefined {
  const ctx = useContext(MemberActionsContext);
  if (!ctx?.rolePickerFor || !pubkey) return undefined;
  return ctx.rolePickerFor(pubkey);
}

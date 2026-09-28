import { useContext } from "react";

import { MemberActionsContext, type MemberActionItem, type MemberRolePicker } from "@/contexts/MemberActionsContext";

/** Never throws for a missing provider — shared surfaces render identically without one. */
export function useMemberActions(pubkey: string | undefined): MemberActionItem[] {
  const ctx = useContext(MemberActionsContext);
  if (!ctx || !pubkey) return EMPTY;
  return ctx.actionsFor(pubkey);
}

const EMPTY: MemberActionItem[] = [];

export function useMemberRolePicker(pubkey: string | undefined): MemberRolePicker | undefined {
  const ctx = useContext(MemberActionsContext);
  if (!ctx?.rolePickerFor || !pubkey) return undefined;
  return ctx.rolePickerFor(pubkey);
}

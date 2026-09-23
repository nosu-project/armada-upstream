import { useContext } from "react";

import { MemberActionsContext, type MemberActionItem } from "@/contexts/MemberActionsContext";

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

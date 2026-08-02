import { useContext } from "react";

import { MemberRolesContext, type MemberRole } from "@/contexts/MemberRolesContext";

/**
 * The current community's roles for one member, or an empty list outside a
 * scope that has any (NIP-29 groups, DMs). Never throws for a missing
 * provider — a shared surface must render identically without one.
 */
export function useMemberRoles(pubkey: string | undefined): MemberRole[] {
  const ctx = useContext(MemberRolesContext);
  if (!ctx || !pubkey) return EMPTY;
  return ctx.rolesOf(pubkey);
}

const EMPTY: MemberRole[] = [];

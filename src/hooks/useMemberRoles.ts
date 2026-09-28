import { useContext } from "react";

import { MemberRolesContext, type MemberRole } from "@/contexts/MemberRolesContext";

/** Empty outside a scope with roles. Never throws for a missing provider. */
export function useMemberRoles(pubkey: string | undefined): MemberRole[] {
  const ctx = useContext(MemberRolesContext);
  if (!ctx || !pubkey) return EMPTY;
  return ctx.rolesOf(pubkey);
}

const EMPTY: MemberRole[] = [];

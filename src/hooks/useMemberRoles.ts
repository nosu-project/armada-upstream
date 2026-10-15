import { useContext } from "react";

import { MemberRolesContext, type MemberRole, type StaffTier } from "@/contexts/MemberRolesContext";

/** Empty outside a scope with roles. Never throws for a missing provider. */
export function useMemberRoles(pubkey: string | undefined): MemberRole[] {
  const ctx = useContext(MemberRolesContext);
  if (!ctx || !pubkey) return EMPTY;
  return ctx.rolesOf(pubkey);
}

/** Undefined outside a scope with roles. */
export function useStaffTier(pubkey: string | undefined): StaffTier | undefined {
  const ctx = useContext(MemberRolesContext);
  if (!ctx || !pubkey) return undefined;
  return ctx.staffTierOf(pubkey);
}

const EMPTY: MemberRole[] = [];

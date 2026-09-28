import { createContext } from "react";

/**
 * A member's roles in the CURRENT community, via context so {@link ProfilePreviewCard}
 * can show them from any call site. Display data only.
 */
export interface MemberRole {
  id: string;
  name: string;
  /** Cosmetic badge tint (low 24 bits an #rrggbb); 0 = theme default. */
  color: number;
}

export interface MemberRolesValue {
  /** This member's roles, highest authority first. Empty when they hold none. */
  rolesOf: (pubkey: string) => MemberRole[];
}

export const MemberRolesContext = createContext<MemberRolesValue | undefined>(undefined);

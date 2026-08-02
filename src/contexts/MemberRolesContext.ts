import { createContext } from "react";

/**
 * A member's roles in the CURRENT community, for surfaces shared across chat
 * backends. {@link ProfilePreviewCard} renders the same card in NIP-29 groups
 * and Concord communities, so the roles reach it through context rather than a
 * prop threaded down every call site (member list, message author, mention,
 * voice roster). A scope that has no roles simply never provides it and the
 * card renders exactly as before.
 *
 * Display data only — authority is always re-derived from the fold.
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

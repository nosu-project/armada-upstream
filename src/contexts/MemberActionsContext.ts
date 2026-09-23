import type { LucideIcon } from "lucide-react";
import { createContext } from "react";

/**
 * What the VIEWER may do to one member of the current community, for surfaces
 * shared across chat backends.
 *
 * Sibling of {@link MemberRolesContext}, and provided for the same reason:
 * {@link ProfilePreviewCard} is rendered from every surface that shows a
 * person — a message author's avatar and name, a member row, a mention, a
 * voice roster — and takes only a pubkey, so moderation cannot reach it as
 * props threaded down each of those call sites. A scope that moderates nobody
 * (a DM, a bare profile) simply never provides it and the card renders exactly
 * as before.
 *
 * The provider hands over FINISHED actions rather than capability flags, so
 * the backend keeps its own vocabulary (Concord's ban is "Ban & lock out" only
 * when it will rotate keys) and a new action costs no change to the context or
 * the surfaces reading it.
 *
 * Affordances only. An action listed here is a claim about what the viewer may
 * do, re-derived from the fold on every read; the mutation behind it checks
 * the same authority again, because this list can be stale by the time it is
 * clicked.
 */
export interface MemberActionItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Rendered in the destructive style and, by convention, listed last. */
  destructive?: boolean;
  onSelect: () => void;
}

export interface MemberActionsValue {
  /**
   * This viewer's actions against this member, empty when they have none —
   * which is the common case, and covers both "not staff" and "staff who
   * doesn't outrank them".
   */
  actionsFor: (pubkey: string) => MemberActionItem[];
}

export const MemberActionsContext = createContext<MemberActionsValue | undefined>(undefined);

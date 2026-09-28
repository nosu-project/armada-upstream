/**
 * Whether a parked catch-up invite (a Direct Invite carrying a private-channel
 * key an existing member lacks — how a role grant's key arrives, CORD-05 §6) may
 * be adopted WITHOUT a click. Consent came from the Grant; this checks the bundle
 * is the delivery it prescribes, against the folded Control Plane:
 *
 *   - the sender is owner or staff (CORD-04 §3), so a plain keyholder can't plant
 *     a wrong key that would block the right one;
 *   - the recipient isn't banned (CORD-04 §4);
 *   - EVERY newly contributed channel is one their roles entitle them to
 *     (`channelAccess.isEntitled`).
 *
 * `"no-fold"` means wait (the Grant's fold lags). Other refusals still allow a
 * manual Accept.
 */

import { isEntitled } from "@/concord/lib/channelAccess";
import { catchUpChannelIds, type HeldMembership } from "@/concord/lib/directInvite";
import type { InviteBundle } from "@/concord/lib/invite";
import { isStaff, type CommunityRoles } from "@/concord/lib/roles";

/** The slice of a `FoldedControl` the decision reads. */
export interface CatchUpFold {
  roster: CommunityRoles;
  ownerHex: string;
  banned: ReadonlySet<string>;
}

export type CatchUpVerdict =
  | "adopt"
  | "no-fold"
  | "nothing-new"
  | "banned"
  | "sender-not-staff"
  | "not-entitled";

export function judgeCatchUp(
  fold: CatchUpFold | undefined,
  recipientHex: string,
  senderHex: string,
  bundle: Pick<InviteBundle, "root_epoch" | "channels" | "community_root" | "control_pk">,
  held: HeldMembership | undefined,
): CatchUpVerdict {
  const vended = catchUpChannelIds(held, bundle);
  if (vended.length === 0) return "nothing-new";
  if (!fold) return "no-fold";
  if (fold.banned.has(recipientHex)) return "banned";
  if (!isStaff(fold.roster, senderHex, fold.ownerHex)) return "sender-not-staff";
  for (const idHex of vended) {
    if (!isEntitled(fold.roster, fold.ownerHex, recipientHex, idHex)) return "not-entitled";
  }
  return "adopt";
}

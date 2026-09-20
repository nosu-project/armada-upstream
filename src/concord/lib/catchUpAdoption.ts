/**
 * Whether a parked catch-up invite may be adopted WITHOUT a click.
 *
 * A Direct Invite for a community the member already belongs to, carrying a
 * private-channel key they lack, is how a role grant's key reaches them
 * (`ConcordPage.handleToggleRole` → `sendDirectInvite`, CORD-05 §6). Parking
 * it behind an explicit Accept was the right default for a JOIN — consent to
 * enter a community is the member's — but for a key they are already owed it
 * only reproduced the failure it was meant to prevent: an admin grants a
 * role, the member sees nothing but a toast, and the channel never appears.
 *
 * Consent for the channel was given by the Grant, not by the bundle, so the
 * question here is only whether the bundle is the delivery the Grant
 * prescribes. Three checks, all against the folded Control Plane the member
 * already verifies:
 *
 *   - the sender is the owner or staff (CORD-04 §3), so a plain member holding
 *     a key cannot plant one unasked — a wrong key at the channel's current
 *     epoch would block the right one, since only a strictly higher channel
 *     epoch parks again;
 *   - the recipient is not banned (CORD-04 §4), judged locally rather than by
 *     the relay round-trip the manual path makes;
 *   - EVERY channel the bundle newly contributes is one the recipient's roles
 *     entitle them to (`channelAccess.isEntitled`), the same ceiling the vend
 *     side applies. A bundle mixing an owed key with one they hold no role
 *     for stays parked, where the inbox shows exactly what it grants.
 *
 * `"no-fold"` is a WAIT, not a refusal: the Grant that entitles the member
 * was published moments before the key was sent, and the fold lags it. The
 * caller re-judges when the fold arrives. Anything else is a verdict the
 * inbox's manual Accept still honours — a non-staff keyholder sharing a key
 * is legitimate (CORD-05 §6 gates a Direct Invite behind no permission), it
 * just isn't automatic.
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
  /** The Control fold hasn't loaded; judge again when it does. */
  | "no-fold"
  /** Not a catch-up on what the member holds (nothing to adopt). */
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

/**
 * Removal verdicts a member can find against THEMSELVES (CORD-04 §6); a removal
 * only counts if it postdates the membership it judges.
 *   - BAN: my npub in the folded Banlist — enforced by the Refounding.
 *   - KICK: my coalesced Guestbook state is `kick` — cooperative, so only this
 *     compliance gives it effect.
 * Pure, so the rules are testable without a fold, vault or relay.
 */

import type { MemberState } from "@/concord/lib/guestbook";

export type SelfRemovalVerdict = "ban" | "kick";

export interface SelfRemovalInput {
  selfHex: string;
  /** The Community owner, who is never a valid target. */
  ownerHex: string;
  /** `added_at` of my vault entry (ms): when THIS membership began. */
  addedAtMs: number;
  /** Does the folded Banlist name me? */
  banned: boolean;
  /** `created_at` (SECONDS) of the held head Banlist edition, if any. */
  banlistHeadAtSecs: number | undefined;
  /** My coalesced Guestbook entry, if the plane has folded. */
  guestbook: { state: MemberState; ms: number } | undefined;
}

/**
 * Which removal, if any, this member is under. A ban outranks a kick. Both must
 * POSTDATE `addedAtMs`: compaction can resurface an old Banlist edition, and the
 * old `kick` entry lingers until a rejoin's Join is swept.
 */
export function selfRemovalVerdict(input: SelfRemovalInput): SelfRemovalVerdict | null {
  // The owner is never a valid target (explicit here rather than inherited from the fold).
  if (input.selfHex === input.ownerHex) return null;

  if (input.banned && input.banlistHeadAtSecs !== undefined && input.banlistHeadAtSecs * 1000 > input.addedAtMs) {
    return "ban";
  }
  if (kickVerdictPostdatesMembership(input.guestbook, input.selfHex, input.ownerHex, input.addedAtMs)) return "kick";
  return null;
}

/**
 * Whether the coalesced Guestbook carries a Kick against THIS membership — the
 * kick half of {@link selfRemovalVerdict}, standalone for the live-call watcher.
 * The `addedAtMs` floor covers a rejoin whose Join hasn't been swept yet.
 */
export function kickVerdictPostdatesMembership(
  guestbook: { state: MemberState; ms: number } | undefined,
  selfHex: string | undefined,
  ownerHex: string | undefined,
  addedAtMs: number | undefined,
): boolean {
  if (!guestbook || !selfHex || !ownerHex || addedAtMs === undefined) return false;
  if (selfHex === ownerHex) return false;
  return guestbook.state === "kick" && guestbook.ms > addedAtMs;
}

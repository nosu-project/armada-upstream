/**
 * The verdicts a member can find against THEMSELVES, and the one rule both
 * obey: a removal only counts if it postdates the membership it judges.
 *
 * Two planes carry a removal (CORD-04 §6), and an honest client complies with
 * either — the local effect is the same, because "removed from the community"
 * is one state whatever minted it:
 *
 *   - BAN: my npub in the folded Control-plane Banlist. Enforced (the
 *     Refounding severs the keys) and irreversible without a re-invite.
 *   - KICK: my coalesced Guestbook state is `kick`. Cooperative and
 *     unenforced — the keys still open the stream, so nothing but this
 *     compliance makes a kick mean anything on the kicked member's own
 *     screen.
 *
 * Kept pure and separate from the hook so the ordering and the two staleness
 * rules are testable without a fold, a vault or a relay.
 */

import type { MemberState } from "@/concord/lib/guestbook";

export type SelfRemovalVerdict = "ban" | "kick";

export interface SelfRemovalInput {
  /** The viewer. */
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
 * Which removal, if any, this member is currently under.
 *
 * A ban outranks a kick: it is the enforced one and its teardown is a superset,
 * so a member under both is reported banned and the caller never has to decide.
 *
 * Both verdicts must POSTDATE `addedAtMs`, for the same reason and against two
 * different hazards. A compaction re-wraps Banlist editions verbatim, so a
 * fresh joiner's first fold can resurface a sentence older than their
 * re-admission; and a kick is freely re-joinable, so the Guestbook keeps the
 * old `kick` entry until the new self-signed Join is swept — a rejoin that
 * acted on its own stale kick would tear itself down on the way in.
 */
export function selfRemovalVerdict(input: SelfRemovalInput): SelfRemovalVerdict | null {
  // The fold's Banlist validator and roles engine both refuse the owner as a
  // target; checking here makes the precondition explicit rather than inherited.
  if (input.selfHex === input.ownerHex) return null;

  if (input.banned && input.banlistHeadAtSecs !== undefined && input.banlistHeadAtSecs * 1000 > input.addedAtMs) {
    return "ban";
  }
  if (kickVerdictPostdatesMembership(input.guestbook, input.selfHex, input.ownerHex, input.addedAtMs)) return "kick";
  return null;
}

/**
 * Whether the coalesced Guestbook carries a Kick against THIS membership — the
 * kick half of {@link selfRemovalVerdict}, standalone so the live-call watcher
 * can ask it beside `banVerdictPostdatesMembership` without folding the
 * question into one verdict computed two different ways.
 *
 * `guestbook` is my COALESCED entry, so a Join newer than the kick has already
 * won and this reads `join`. The `addedAtMs` floor covers the gap before that
 * Join is swept back: a rejoiner whose own entry hasn't come around yet would
 * otherwise act on the kick that admitted them.
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

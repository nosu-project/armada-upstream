/**
 * Live call enforcement (CORD-07 §1/§7): while a member is connected to a
 * Channel's voice room, the room they SHOULD be in can change out from under
 * them — a Rekey/Refounding rolls the room name and media key (severing a
 * removed member), a ban or a kick names them directly, or the community
 * leaves their vault entirely. The connected room itself is a join-time
 * snapshot, so a watcher must compare it against the LIVE vault + control fold
 * and decide: stay, rejoin the freshly-derived room, or hang up.
 *
 * The decision is a pure function so the enforcement rules are testable
 * without LiveKit or React.
 */

import type { FoldedControl } from "@/concord/lib/control";
import type { Channel, Community } from "@/concord/lib/types";

export type CallSyncDecision =
  | { action: "stay" }
  | { action: "leave"; reason: "removed" | "banned" | "kicked" | "channel-gone" }
  | { action: "rejoin"; community: Community; channel: Channel };

/**
 * Whether the folded Banlist carries a verdict on THIS membership: the newest
 * authorized banlist edition naming `pubkey` postdates when they (re)joined.
 * A compaction re-wraps banlist editions verbatim (original timestamps
 * survive), so a sentence older than a re-admission is a stale verdict, not a
 * judgment on the current membership — the same rule `useSelfRemove`
 * applies before tearing down the vault. The kick half of the question lives
 * in `selfRemoval.ts` (`kickVerdictPostdatesMembership`), since it is answered
 * from the Guestbook rather than from the fold.
 */
export function banVerdictPostdatesMembership(
  folded: FoldedControl | undefined,
  pubkey: string | undefined,
  addedAtMs: number | undefined,
): boolean {
  if (!folded || !pubkey || addedAtMs === undefined) return false;
  // The fold's Banlist validator already refuses the owner as a target.
  if (pubkey === folded.ownerHex) return false;
  if (!folded.banned.has(pubkey)) return false;
  const bannedAtSecs = folded.bannedAt.get(pubkey);
  return bannedAtSecs !== undefined && bannedAtSecs * 1000 > addedAtMs;
}

/**
 * Compare the connected room's join-time snapshot against live state.
 *
 *   - a ban or kick verdict on this membership hangs up immediately;
 *   - a vault entry that's gone (left, or the self-removal already ran)
 *     hangs up;
 *   - a live channel whose epoch/room differs from the snapshot rejoins at
 *     the fresh coordinates (the rotation that severed a removed member from
 *     chat must move the call too, or everyone stays in the room the removed
 *     member can still derive — CORD-07 §7);
 *   - a channel absent from the live view (deleted, or a private channel
 *     whose rotated key we weren't dealt) hangs up — the new room is
 *     underivable;
 *   - anything still loading stays put (fail-safe: never tear down a call on
 *     transiently-missing data).
 */
export function decideCallSync(input: {
  /** The joined call's coordinates, frozen at join time. */
  snapshot: { channelIdHex: string; epoch: bigint; roomPk: string };
  /** Whether the community-list vault has loaded at all. */
  listLoaded: boolean;
  /** The LIVE community from the vault (undefined = no entry). */
  community: Community | undefined;
  /** The LIVE control fold (undefined = still loading). */
  folded: FoldedControl | undefined;
  /** The LIVE channels view assembled from `community` + `folded`. */
  channels: readonly Channel[];
  /** Whether a ban verdict postdating this membership names me. */
  selfBanned: boolean;
  /** Whether a Guestbook Kick postdating this membership names me. */
  selfKicked: boolean;
}): CallSyncDecision {
  // A removal is a judgment: hang up regardless of what else has (not) loaded.
  // A kick severs nothing cryptographically — the room key still derives — so
  // this compliance IS the removal, exactly as it is on the chat side.
  if (input.selfBanned) return { action: "leave", reason: "banned" };
  if (input.selfKicked) return { action: "leave", reason: "kicked" };
  // The vault has loaded and the community is gone — the member left, or the
  // compliant self-removal already tore the entry down.
  if (input.listLoaded && !input.community) return { action: "leave", reason: "removed" };
  if (!input.community || !input.folded) return { action: "stay" };

  const live = input.channels.find((ch) => ch.idHex === input.snapshot.channelIdHex);
  // The fold is live and the channel is not in view: deleted, or a private
  // channel whose rotated key this member wasn't dealt.
  if (!live) return { action: "leave", reason: "channel-gone" };

  if (live.current.epoch !== input.snapshot.epoch || live.voice.room.pk !== input.snapshot.roomPk) {
    return { action: "rejoin", community: input.community, channel: live };
  }
  return { action: "stay" };
}

/**
 * Live call enforcement (CORD-07 §1/§7): the connected room is a join-time
 * snapshot, so compare it against the LIVE vault + control fold and decide:
 * stay, rejoin the freshly-derived room (after a Rekey/Refounding), or hang up
 * (ban, kick, or community gone). Pure for testability.
 */

import type { FoldedControl } from "@/concord/lib/control";
import type { Channel, Community } from "@/concord/lib/types";

export type CallSyncDecision =
  | { action: "stay" }
  | { action: "leave"; reason: "removed" | "banned" | "kicked" | "channel-gone" }
  | { action: "rejoin"; community: Community; channel: Channel };

/**
 * Whether the newest authorized banlist edition naming `pubkey` postdates their
 * (re)join. Compaction keeps original timestamps, so an older sentence is stale
 * (same rule as `useSelfRemove`). Kicks: see `kickVerdictPostdatesMembership`.
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
 * Compare the connected room's join-time snapshot against live state:
 *
 *   - a ban/kick verdict on this membership, or a vanished vault entry → hang up;
 *   - a live channel whose epoch/room changed → rejoin at the fresh coordinates
 *     (the rotation must move the call too, CORD-07 §7);
 *   - a channel absent from the live view (deleted, or a rotated key we weren't
 *     dealt) → hang up;
 *   - anything still loading → stay (never tear down on transient data).
 */
export function decideCallSync(input: {
  /** The joined call's coordinates, frozen at join time. */
  snapshot: { channelIdHex: string; epoch: bigint; roomPk: string };
  listLoaded: boolean;
  /** The LIVE community from the vault (undefined = no entry). */
  community: Community | undefined;
  folded: FoldedControl | undefined;
  channels: readonly Channel[];
  /** Whether a ban verdict postdating this membership names me. */
  selfBanned: boolean;
  /** Whether a Guestbook Kick postdating this membership names me. */
  selfKicked: boolean;
  /** Whether this community has been dissolved (terminal, CORD-02 §9). */
  dissolved: boolean;
}): CallSyncDecision {
  // A removal is a judgment: hang up regardless of loading. A kick severs nothing
  // cryptographically, so this compliance IS the removal.
  if (input.selfBanned) return { action: "leave", reason: "banned" };
  if (input.selfKicked) return { action: "leave", reason: "kicked" };
  // Dissolution severs no key, so the call finishes on its own terms; without this
  // the dropped vault entry below would boot everyone.
  if (input.dissolved) return { action: "stay" };
  if (input.listLoaded && !input.community) return { action: "leave", reason: "removed" };
  if (!input.community || !input.folded) return { action: "stay" };

  const live = input.channels.find((ch) => ch.idHex === input.snapshot.channelIdHex);
  if (!live) return { action: "leave", reason: "channel-gone" };

  if (live.current.epoch !== input.snapshot.epoch || live.voice.room.pk !== input.snapshot.roomPk) {
    return { action: "rejoin", community: input.community, channel: live };
  }
  return { action: "stay" };
}

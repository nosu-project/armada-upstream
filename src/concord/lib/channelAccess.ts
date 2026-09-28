/**
 * Who may read a Private Channel (CORD-03/04/06). The Roles scoped to a channel
 * (CORD-04 §2 `scope: {kind:"channel", channel_id}`) ARE its access list. Read
 * access is still enforced by key possession alone (CORD-04 §1); this decides who
 * a key is delivered TO on grant and who a rekey keeps on revoke.
 */

import { bytesToHex } from "@/concord/lib/derive";
import { byDisplayOrder, rolesOf, type CommunityRoles, type Role } from "@/concord/lib/roles";

/**
 * The Roles conferring read access to `channelIdHex`, in display order. A Private
 * Channel with none is degenerate (readable only by the owner and existing key
 * holders); clients shouldn't create one, but it still reads correctly.
 */
export function channelRoles(roster: CommunityRoles | undefined, channelIdHex: string): Role[] {
  const wanted = channelIdHex.toLowerCase();
  return (roster?.roles ?? [])
    .filter((r) => r.scope.kind === "channel" && r.scope.channelId.toLowerCase() === wanted)
    .sort(byDisplayOrder);
}

/** {@link channelRoles}, by id. */
export function channelRoleIds(roster: CommunityRoles | undefined, channelIdHex: string): string[] {
  return channelRoles(roster, channelIdHex).map((r) => r.roleId);
}

/**
 * Is `memberHex` entitled to `channelIdHex`'s key? The owner always is (CORD-04 §2).
 * `withRoleIds`/`withoutRoleIds` overlay a just-published Grant the fold lags.
 */
export function isEntitled(
  roster: CommunityRoles | undefined,
  ownerHex: string | undefined,
  memberHex: string,
  channelIdHex: string,
  overlay?: { withRoleIds?: string[]; withoutRoleIds?: string[] },
): boolean {
  if (memberHex === ownerHex) return true;
  if (!roster) return false;
  const held = new Set(rolesOf(roster, memberHex).map((r) => r.roleId));
  for (const id of overlay?.withRoleIds ?? []) held.add(id);
  for (const id of overlay?.withoutRoleIds ?? []) held.delete(id);
  return channelRoleIds(roster, channelIdHex).some((id) => held.has(id));
}

/**
 * Who an invite bundle is FOR, which bounds the Private Channel keys it may carry.
 * A **link** has no recipient and holds no Role (CORD-05 §2), so gets none. A
 * **member** gets exactly the channels their roles grant; `overlay` accounts for
 * a Grant just published.
 */
export type VendAudience =
  | { kind: "link" }
  | {
      kind: "member";
      roster: CommunityRoles | undefined;
      ownerHex: string | undefined;
      memberHex: string;
      overlay?: { withRoleIds?: string[]; withoutRoleIds?: string[] };
    };

/**
 * The held Private Channel keys an invite bundle may carry (CORD-05 §1).
 * Entitlement (CORD-03 §1, CORD-04 §2) is the ceiling; `only`/`exclude` narrow
 * beneath it. That CORD-05 §6 can't PREVENT an unentitled whisper doesn't make
 * one right. An unloaded roster throws rather than vending nothing.
 */
export function vendableChannels<T extends { id: Uint8Array }>(
  held: readonly T[],
  audience: VendAudience,
  opts?: { only?: ReadonlySet<string>; exclude?: ReadonlySet<string> },
): T[] {
  if (held.length === 0) return [];
  if (audience.kind === "link") return [];
  if (!audience.roster) {
    throw new Error("Still loading this community's roles; try again in a moment.");
  }
  const { roster, ownerHex, memberHex, overlay } = audience;
  return held.filter((ch) => {
    const idHex = bytesToHex(ch.id);
    if (opts?.exclude?.has(idHex)) return false;
    if (opts?.only && !opts.only.has(idHex)) return false;
    return isEntitled(roster, ownerHex, memberHex, idHex, overlay);
  });
}

/**
 * Channels whose access for `memberHex` HINGES on `roleId`, split by whether this
 * client holds the key. `unheld` channels still need rotating by someone who
 * holds them, or a revoke reports success while the target keeps reading.
 */
export function channelsHingingOn(
  roster: CommunityRoles,
  ownerHex: string | undefined,
  memberHex: string,
  roleId: string,
  channels: ReadonlyArray<{ idHex: string; heldByMe: boolean }>,
): { held: string[]; unheld: string[] } {
  const held: string[] = [];
  const unheld: string[] = [];
  for (const ch of channels) {
    if (!isEntitled(roster, ownerHex, memberHex, ch.idHex, { withRoleIds: [roleId] })) continue;
    if (isEntitled(roster, ownerHex, memberHex, ch.idHex, { withoutRoleIds: [roleId] })) continue;
    (ch.heldByMe ? held : unheld).push(ch.idHex);
  }
  return { held, unheld };
}

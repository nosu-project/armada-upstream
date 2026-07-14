/**
 * Regression: a Concord V2 community the user is STILL a member of disappears
 * from the rail permanently once a rekey adoption and an old removal tombstone
 * meet in the merge.
 *
 * `refreshCurrent` (the rekey-adoption write) replaces `current` but does NOT
 * bump `added_at` — it keeps the original join time. Liveness is decided by
 * `isLive`: `entry.added_at > tomb.removed_at`. So if ANY tombstone exists with
 * a `removed_at` later than the original `added_at` — e.g. a transient
 * kick/refound round on another device, or a stale removal the member has since
 * recovered from by adopting a newer epoch — the adopted-and-kept entry is
 * judged dead forever, even though the member currently holds a valid current
 * epoch key.
 *
 * A rekey adoption is proof of CURRENT membership; it must win liveness over an
 * older removal, exactly like a re-join does (addToList bumps added_at). Because
 * it doesn't, the community vanishes and — since the tombstone is permanent and
 * the merge is deterministic across devices — stays gone until a real re-join.
 */

import { describe, expect, it } from "vitest";

import {
  addToList,
  EMPTY_COMMUNITY_LIST,
  isLive,
  liveEntries,
  mergeCommunityLists,
  refreshCurrent,
  removeFromList,
  type CommunityListEntry,
  type JoinMaterial,
} from "@/concord-v2/lib/communityList";
import { bytesToHex, random32 } from "@/concord-v2/lib/derive";

function jm(overrides: Partial<JoinMaterial> = {}): JoinMaterial {
  return {
    community_id: bytesToHex(random32()),
    owner: bytesToHex(random32()),
    owner_salt: bytesToHex(random32()),
    community_root: bytesToHex(random32()),
    root_epoch: 0,
    channels: [],
    relays: ["wss://a.example"],
    name: "Fleet",
    ...overrides,
  };
}

function entryOf(material: JoinMaterial, addedAt: number): CommunityListEntry {
  return { community_id: material.community_id, seed: material, current: material, added_at: addedAt };
}

describe("rekey adoption vs. an older removal tombstone", () => {
  it("re-included after an exclusion: adoption must resurrect (single-device, rekey-watcher only)", () => {
    // The exact sequence the rekey watcher can produce on ONE device:
    //  1. join at t=1000
    //  2. refound epoch 1 EXCLUDES the member → watcher writes a `remove`
    //     tombstone at removed_at=2000 (useRekey2.ts:212).
    //  3. the owner refounds AGAIN at epoch 2 and RE-INCLUDES the member →
    //     watcher adopts and writes `refresh-current` (useRekey2.ts:200), which
    //     keeps added_at=1000.
    // The member now holds the epoch-2 key (definitively a current member),
    // but isLive compares added_at(1000) > removed_at(2000) → false. Gone.
    const seed = jm({ root_epoch: 0 });
    const cid = seed.community_id;

    let list = addToList(EMPTY_COMMUNITY_LIST, entryOf(seed, 1000));
    list = removeFromList(list, cid, 2000); // excluded in the first refound
    expect(isLive(list, cid)).toBe(false);

    // Re-included: the watcher adopts epoch 2 via refresh-current.
    const epoch2 = jm({ ...seed, root_epoch: 2, community_root: bytesToHex(random32()) });
    list = refreshCurrent(list, epoch2);
    expect(list.entries[0].current.root_epoch).toBe(2); // key adopted

    // Holding the current key proves membership — must be live. It isn't.
    expect(isLive(list, cid)).toBe(true);
  });

  it("a member who adopted a newer epoch (still in the community) stays live", () => {
    const seed = jm({ root_epoch: 0 });
    const cid = seed.community_id;

    // Device A: the member joined at t=1000, then adopted a Refounding to
    // epoch 1 (rekey watcher → refreshCurrent). refreshCurrent keeps added_at.
    let deviceA = addToList(EMPTY_COMMUNITY_LIST, entryOf(seed, 1000));
    const epoch1 = jm({ ...seed, root_epoch: 1, community_root: bytesToHex(random32()) });
    deviceA = refreshCurrent(deviceA, epoch1);
    expect(deviceA.entries[0].current.root_epoch).toBe(1);
    expect(isLive(deviceA, cid)).toBe(true);

    // Device B saw a transient removal at t=2000 (e.g. a mid-refound race /
    // brief exclusion the member has since recovered from by adopting epoch 1
    // on device A). The tombstone is permanent.
    const deviceB = removeFromList(addToList(EMPTY_COMMUNITY_LIST, entryOf(seed, 1000)), cid, 2000);
    expect(isLive(deviceB, cid)).toBe(false);

    // The two lists sync and merge (SelfSync / cross-device convergence).
    const merged = mergeCommunityLists(deviceA, deviceB);

    // The member currently HOLDS the epoch-1 key (proof of membership), so the
    // community must still be live. It is not: added_at (1000) < removed_at
    // (2000), so the adopted entry is judged dead and the community vanishes.
    expect(liveEntries(merged).map((e) => e.current.name)).toContain("Fleet");
    expect(isLive(merged, cid)).toBe(true);
  });
});

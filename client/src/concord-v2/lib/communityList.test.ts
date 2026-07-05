import { describe, expect, it } from "vitest";

import {
  addToList,
  canonicalJson,
  EMPTY_COMMUNITY_LIST,
  isLive,
  liveEntries,
  mergeCommunityLists,
  rehydrateCommunity,
  removeFromList,
  toJoinMaterial,
  type CommunityListEntry,
  type JoinMaterial,
} from "@/concord-v2/lib/communityList";
import { bytesToHex, communityIdOf, random32 } from "@/concord-v2/lib/derive";

function makeJoinMaterial(overrides: Partial<JoinMaterial> = {}): JoinMaterial {
  const ownerSk = random32();
  const owner = bytesToHex(random32()); // placeholder; overridden below when consistency matters
  void ownerSk;
  return {
    community_id: bytesToHex(random32()),
    owner,
    owner_salt: bytesToHex(random32()),
    community_root: bytesToHex(random32()),
    root_epoch: 0,
    channels: [],
    relays: ["wss://a.example"],
    name: "Test",
    ...overrides,
  };
}

function entryOf(jm: JoinMaterial, addedAt = 1000): CommunityListEntry {
  return { community_id: jm.community_id, seed: jm, current: jm, added_at: addedAt };
}

describe("community list merge (CORD-02 §8)", () => {
  it("is commutative and idempotent", () => {
    const jm1 = makeJoinMaterial();
    const jm2 = makeJoinMaterial();
    const a = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm1));
    const b = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm2));
    const ab = canonicalJson(mergeCommunityLists(a, b));
    const ba = canonicalJson(mergeCommunityLists(b, a));
    expect(ab).toBe(ba);
    expect(canonicalJson(mergeCommunityLists(mergeCommunityLists(a, b), b))).toBe(ab);
  });

  it("current keeps the higher epoch, seed the lower", () => {
    const jm0 = makeJoinMaterial({ root_epoch: 0 });
    const jm2: JoinMaterial = { ...jm0, root_epoch: 2, community_root: bytesToHex(random32()) };
    const merged = mergeCommunityLists(
      { entries: [entryOf(jm0)], tombstones: [] },
      { entries: [entryOf(jm2)], tombstones: [] },
    );
    expect(merged.entries[0].current.root_epoch).toBe(2);
    expect(merged.entries[0].seed.root_epoch).toBe(0);
  });

  it("equal-epoch ties break on canonical bytes (a total order)", () => {
    const jmA = makeJoinMaterial({ name: "AAA" });
    const jmB: JoinMaterial = { ...jmA, name: "ZZZ" };
    const m1 = mergeCommunityLists(
      { entries: [entryOf(jmA)], tombstones: [] },
      { entries: [entryOf(jmB)], tombstones: [] },
    );
    const m2 = mergeCommunityLists(
      { entries: [entryOf(jmB)], tombstones: [] },
      { entries: [entryOf(jmA)], tombstones: [] },
    );
    expect(canonicalJson(m1)).toBe(canonicalJson(m2));
  });

  it("tombstones are permanent; liveness is derived, entries never deleted", () => {
    const jm = makeJoinMaterial();
    let list = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm, 1000));
    list = removeFromList(list, jm.community_id, 2000);
    expect(list.entries.length).toBe(1); // the entry STAYS in the document
    expect(list.tombstones.length).toBe(1);
    expect(isLive(list, jm.community_id)).toBe(false);
    expect(liveEntries(list).length).toBe(0);

    // A re-join (newer add) resurrects; the tombstone stays.
    list = addToList(list, entryOf(jm, 3000));
    expect(isLive(list, jm.community_id)).toBe(true);
    expect(list.tombstones.length).toBe(1);

    // A backfill merging the OLD pre-leave state can't bury the re-join.
    const stale = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm, 1000));
    const merged = mergeCommunityLists(list, stale);
    expect(isLive(merged, jm.community_id)).toBe(true);
  });

  it("round-trips unknown fields (the round-trip discipline)", () => {
    const jm = makeJoinMaterial({ vector_custom: { theme: "dark" } } as Partial<JoinMaterial>);
    const list = addToList(EMPTY_COMMUNITY_LIST, entryOf(jm));
    const merged = mergeCommunityLists(list, EMPTY_COMMUNITY_LIST);
    expect((merged.entries[0].current as Record<string, unknown>).vector_custom).toEqual({ theme: "dark" });
  });
});

describe("rehydration", () => {
  it("verifies the owner commitment and rebuilds the runtime community", () => {
    const ownerPk = bytesToHex(random32());
    const salt = random32();
    const cid = communityIdOf(
      Uint8Array.from(ownerPk.match(/.{2}/g)!.map((b) => parseInt(b, 16))),
      salt,
    );
    const jm = makeJoinMaterial({
      community_id: bytesToHex(cid),
      owner: ownerPk,
      owner_salt: bytesToHex(salt),
      root_epoch: 3,
      held_roots: [{ epoch: 1, key: bytesToHex(random32()) }],
      channels: [{ id: bytesToHex(random32()), key: bytesToHex(random32()), epoch: 1, name: "secret" }],
    });
    const community = rehydrateCommunity(entryOf(jm), ["wss://app.example"]);
    expect(community).toBeDefined();
    expect(community!.rootEpoch).toBe(3n);
    expect(community!.heldRoots.map((r) => Number(r.epoch))).toEqual([3, 1]);
    expect(community!.privateChannels.length).toBe(1);
    expect(community!.relays).toContain("wss://app.example");

    // A corrupted owner fails closed.
    const corrupt = { ...jm, owner: bytesToHex(random32()) };
    expect(rehydrateCommunity(entryOf(corrupt))).toBeUndefined();
  });

  it("snapshots back to join material, preserving unknown fields", () => {
    const ownerPk = bytesToHex(random32());
    const salt = random32();
    const cid = communityIdOf(
      Uint8Array.from(ownerPk.match(/.{2}/g)!.map((b) => parseInt(b, 16))),
      salt,
    );
    const jm = makeJoinMaterial({
      community_id: bytesToHex(cid),
      owner: ownerPk,
      owner_salt: bytesToHex(salt),
      root_epoch: 1,
      vendor_field: 42,
    } as Partial<JoinMaterial>);
    const community = rehydrateCommunity(entryOf(jm))!;
    const back = toJoinMaterial(community, { prior: jm, relays: jm.relays });
    expect(back.community_id).toBe(jm.community_id);
    expect(back.root_epoch).toBe(1);
    expect((back as Record<string, unknown>).vendor_field).toBe(42);
  });
});

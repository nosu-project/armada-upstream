import { NIndexedDB } from "@nostrify/indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildRelayGroups,
  KIND_GROUP_METADATA,
  relayGroupCacheFilters,
} from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

// Regression tests for the two channel-list offline bugs:
//   1. duplicate/cross-server channels — an unscoped cache read surfaced every
//      server's channels under one server.
//   2. disappearing channels — an empty/sparse relay read replaced (instead of
//      merged with) the cached list, blanking it on a flaky connection.
//
// `relayGroupCacheFilters` + `buildRelayGroups` are the extracted core of
// `useRelayGroups`; the integration block exercises them against the real
// @nostrify/indexeddb store (backed by fake-indexeddb from the test setup),
// which is the actual offline persistence layer.

// Two distinct relays, each with its own signing key (kind 39000 is relay-signed).
const RELAY_A = "wss://a.example.com";
const RELAY_B = "wss://b.example.com";
const SELF_A = "a".repeat(64);
const SELF_B = "b".repeat(64);

let counter = 0;

/** Build a kind-39000 group-metadata event signed by `pubkey`. */
function metadataEvent(opts: {
  id: string;
  pubkey: string;
  groupId: string;
  name: string;
  createdAt?: number;
}): NostrEvent {
  return {
    id: opts.id.padEnd(64, "0").slice(0, 64),
    pubkey: opts.pubkey,
    created_at: opts.createdAt ?? 1000,
    kind: KIND_GROUP_METADATA,
    tags: [
      ["d", opts.groupId],
      ["name", opts.name],
    ],
    content: "",
    sig: "f".repeat(128),
  };
}

describe("relayGroupCacheFilters (scoping — anti cross-server bleed)", () => {
  it("scopes by the relay's own key when known", () => {
    expect(relayGroupCacheFilters(SELF_A, [])).toEqual([
      { kinds: [KIND_GROUP_METADATA], authors: [SELF_A] },
    ]);
  });

  it("falls back to the remembered ids' d-tag when the relay key is unknown", () => {
    expect(relayGroupCacheFilters(undefined, ["g1", "g2"])).toEqual([
      { kinds: [KIND_GROUP_METADATA], "#d": ["g1", "g2"] },
    ]);
  });

  it("NEVER produces an unscoped { kinds: [39000] } read", () => {
    // The original bug: with no relay key and nothing remembered, the seed read
    // every server's metadata. Now it returns no filters instead.
    const filters = relayGroupCacheFilters(undefined, []);
    expect(filters).toEqual([]);
    // And in the cases where it does read, every filter is relay-scoped.
    for (const f of [
      ...relayGroupCacheFilters(SELF_A, []),
      ...relayGroupCacheFilters(undefined, ["g1"]),
    ]) {
      expect("authors" in f || "#d" in f).toBe(true);
    }
  });
});

describe("buildRelayGroups (dedup + merge floor)", () => {
  it("dedupes by group id, keeping the newest event", () => {
    const older = metadataEvent({ id: "1", pubkey: SELF_A, groupId: "g1", name: "Old", createdAt: 100 });
    const newer = metadataEvent({ id: "2", pubkey: SELF_A, groupId: "g1", name: "New", createdAt: 200 });

    // Order-independent: newest created_at wins regardless of array order.
    expect(buildRelayGroups([older, newer], RELAY_A).map((g) => g.name)).toEqual(["New"]);
    expect(buildRelayGroups([newer, older], RELAY_A).map((g) => g.name)).toEqual(["New"]);
  });

  it("sorts channels by name", () => {
    const zed = metadataEvent({ id: "1", pubkey: SELF_A, groupId: "g1", name: "Zed" });
    const abe = metadataEvent({ id: "2", pubkey: SELF_A, groupId: "g2", name: "Abe" });
    expect(buildRelayGroups([zed, abe], RELAY_A).map((g) => g.name)).toEqual(["Abe", "Zed"]);
  });

  it("skips malformed events (no d tag)", () => {
    const bad: NostrEvent = { ...metadataEvent({ id: "1", pubkey: SELF_A, groupId: "x", name: "X" }), tags: [["name", "X"]] };
    expect(buildRelayGroups([bad], RELAY_A)).toEqual([]);
  });

  it("stamps every group with the relay it was built for", () => {
    const ev = metadataEvent({ id: "1", pubkey: SELF_A, groupId: "g1", name: "Chan" });
    expect(buildRelayGroups([ev], RELAY_A)[0].relay).toBe(RELAY_A);
  });

  describe("merge floor (cache first, network second)", () => {
    const cached = metadataEvent({ id: "1", pubkey: SELF_A, groupId: "g1", name: "Cached" });

    it("keeps cached channels when the relay returns NOTHING", () => {
      // The disappearing-channels bug: an empty relay read must not blank the list.
      const result = buildRelayGroups([cached, /* network: */], RELAY_A);
      expect(result.map((g) => g.id)).toEqual(["g1"]);
    });

    it("a newer relay edit supersedes the cached copy", () => {
      const edited = metadataEvent({ id: "2", pubkey: SELF_A, groupId: "g1", name: "Edited", createdAt: 2000 });
      const result = buildRelayGroups([cached, edited], RELAY_A);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Edited");
    });

    it("the network adds channels the cache didn't have", () => {
      const fresh = metadataEvent({ id: "2", pubkey: SELF_A, groupId: "g2", name: "Fresh" });
      const result = buildRelayGroups([cached, fresh], RELAY_A);
      expect(result.map((g) => g.id).sort()).toEqual(["g1", "g2"]);
    });
  });
});

describe("integration: scoped reads against @nostrify/indexeddb", () => {
  let store: NIndexedDB;
  const dbNames: string[] = [];

  beforeEach(() => {
    const name = `relay-groups-test-${Date.now()}-${counter++}`;
    dbNames.push(name);
    store = new NIndexedDB(name);
  });

  afterEach(async () => {
    await store.close();
    for (const name of dbNames) {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    }
    dbNames.length = 0;
  });

  /** Persist events and wait for the store's batched flush to commit. */
  async function persist(...events: NostrEvent[]): Promise<void> {
    await Promise.all(events.map((e) => store.event(e)));
  }

  it("a scoped read returns only the queried relay's channels (no cross-server bleed)", async () => {
    // Both servers' relay-signed metadata land in the SAME shared cache.
    await persist(
      metadataEvent({ id: "a1", pubkey: SELF_A, groupId: "ga1", name: "A-General" }),
      metadataEvent({ id: "a2", pubkey: SELF_A, groupId: "ga2", name: "A-Random" }),
      metadataEvent({ id: "b1", pubkey: SELF_B, groupId: "gb1", name: "B-General" }),
    );

    // Reading relay A scoped by its own key must NOT surface relay B's channel.
    const cachedA = await store.query(relayGroupCacheFilters(SELF_A, []));
    const groupsA = buildRelayGroups(cachedA, RELAY_A);
    expect(groupsA.map((g) => g.name)).toEqual(["A-General", "A-Random"]);
    expect(groupsA.some((g) => g.name.startsWith("B-"))).toBe(false);

    // And relay B sees only its own.
    const cachedB = await store.query(relayGroupCacheFilters(SELF_B, []));
    expect(buildRelayGroups(cachedB, RELAY_B).map((g) => g.name)).toEqual(["B-General"]);

    // Negative control: the OLD unscoped read `{ kinds: [39000] }` DID bleed —
    // it returned every server's channels. This proves the scoping above is
    // what prevents the duplicate/cross-server bug, not an artifact of the data.
    const unscoped = await store.query([{ kinds: [KIND_GROUP_METADATA] }]);
    expect(buildRelayGroups(unscoped, RELAY_A).map((g) => g.name)).toEqual([
      "A-General",
      "A-Random",
      "B-General",
    ]);
  });

  it("the cache survives an empty relay read (disappearing-channels regression)", async () => {
    await persist(
      metadataEvent({ id: "a1", pubkey: SELF_A, groupId: "ga1", name: "A-General" }),
    );

    // Simulate the queryFn merge with an EMPTY network response.
    const cached = await store.query(relayGroupCacheFilters(SELF_A, []));
    const networkEvents: NostrEvent[] = [];
    const merged = buildRelayGroups([...cached, ...networkEvents], RELAY_A);

    expect(merged.map((g) => g.id)).toEqual(["ga1"]);
  });

  it("addressable supersession: only the newest metadata per group id is stored", async () => {
    // Two versions of the same group (same d tag, same relay key). The store's
    // replaceable/addressable supersession should keep only the newest.
    await persist(
      metadataEvent({ id: "old", pubkey: SELF_A, groupId: "ga1", name: "Old Name", createdAt: 100 }),
    );
    await persist(
      metadataEvent({ id: "new", pubkey: SELF_A, groupId: "ga1", name: "New Name", createdAt: 200 }),
    );

    const cached = await store.query(relayGroupCacheFilters(SELF_A, []));
    const groups = buildRelayGroups(cached, RELAY_A);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("New Name");
  });

  it("falls back to remembered ids when the relay key is unknown, still scoped", async () => {
    await persist(
      metadataEvent({ id: "a1", pubkey: SELF_A, groupId: "ga1", name: "A-General" }),
      metadataEvent({ id: "b1", pubkey: SELF_B, groupId: "gb1", name: "B-General" }),
    );

    // Before NIP-11 resolves (relaySelf unknown), we remember only ga1 for relay A.
    const cached = await store.query(relayGroupCacheFilters(undefined, ["ga1"]));
    const groups = buildRelayGroups(cached, RELAY_A);
    expect(groups.map((g) => g.id)).toEqual(["ga1"]);
  });
});

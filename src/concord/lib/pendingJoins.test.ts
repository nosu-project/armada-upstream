import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetPendingJoinsForTests,
  addPendingJoin,
  pendingJoinEntries,
  removePendingJoin,
  subscribePendingJoins,
} from "./pendingJoins";

import type { CommunityListEntry } from "./communityList";

function entry(id: string): CommunityListEntry {
  const jm = {
    community_id: id,
    owner: "0".repeat(64),
    owner_salt: "1".repeat(64),
    community_root: "2".repeat(64),
    root_epoch: 0,
    channels: [],
    relays: ["wss://relay.example"],
    name: `community ${id}`,
  };
  return { community_id: id, seed: jm, current: jm, added_at: Date.now() };
}

describe("pendingJoins", () => {
  afterEach(() => {
    _resetPendingJoinsForTests();
  });

  it("adds, lists and removes entries, notifying subscribers", () => {
    const listener = vi.fn();
    subscribePendingJoins(listener);

    addPendingJoin(entry("aa"));
    expect(pendingJoinEntries().map((e) => e.community_id)).toEqual(["aa"]);
    expect(listener).toHaveBeenCalledTimes(1);

    removePendingJoin("aa");
    expect(pendingJoinEntries()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps a stable snapshot identity between changes (useSyncExternalStore)", () => {
    addPendingJoin(entry("aa"));
    const first = pendingJoinEntries();
    expect(pendingJoinEntries()).toBe(first);
    addPendingJoin(entry("bb"));
    expect(pendingJoinEntries()).not.toBe(first);
  });

  it("removing an unknown id neither throws nor notifies", () => {
    const listener = vi.fn();
    subscribePendingJoins(listener);
    removePendingJoin("missing");
    expect(listener).not.toHaveBeenCalled();
  });

  it("re-adding the same community replaces the entry", () => {
    addPendingJoin(entry("aa"));
    const fresher = entry("aa");
    addPendingJoin(fresher);
    expect(pendingJoinEntries()).toHaveLength(1);
    expect(pendingJoinEntries()[0]).toBe(fresher);
  });
});

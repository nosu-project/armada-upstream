import { describe, expect, it, vi } from "vitest";

import {
  LatestSerialRunner,
  mergePushReplacementSpec,
  reconcilePushRegistrations,
} from "@/lib/pushRegistration";

import type { PushSubscriptionSpec } from "@/lib/pushSubscriptions";

function groupSpec(
  id: string,
  relay: string,
  groupId: string,
): PushSubscriptionSpec {
  return {
    id,
    relays: [relay],
    filter: { kinds: [9], "#h": [groupId] },
    notification: {
      title: "New message",
      body: "",
      data: { scope: "group", relays: [relay], inline_event: true },
    },
  };
}

describe("reconcilePushRegistrations", () => {
  it("rebuilds the full broad predecessor rather than one child's filter", () => {
    const merged = mergePushReplacementSpec("G", [
      groupSpec("G-A", "wss://a", "alpha"),
      groupSpec("G-B", "wss://b", "beta"),
    ]);
    expect(merged).toMatchObject({
      id: "G",
      relays: ["wss://a", "wss://b"],
      filter: { kinds: [9], "#h": ["alpha", "beta"] },
      notification: {
        data: { relays: ["wss://a", "wss://b"] },
      },
    });
  });

  it("falls back to the broad watch at a no-stale full quota and refreshes later records", async () => {
    const live = new Set(["G", "DM", "C2"]);
    const quota = live.size;
    const order: string[] = [];
    const put = async (id: string) => {
      order.push(`put:${id}`);
      if (!live.has(id) && live.size >= quota) throw new Error("quota exceeded");
      live.add(id);
    };
    const replacementGroup = {
      key: "G",
      fallbackId: "G",
      restoreFallback: (id: string) => put(id),
    };

    const result = await reconcilePushRegistrations({
      desired: [
        { id: "G-A", replaces: ["G"], register: () => put("G-A"), replacementGroup },
        { id: "G-B", replaces: ["G"], register: () => put("G-B"), replacementGroup },
        { id: "DM", register: () => put("DM") },
        { id: "C2", register: () => put("C2") },
      ],
      trackedIds: [...live],
      deleteRegistration: async (id) => {
        order.push(`delete:${id}`);
        live.delete(id);
      },
      persistTrackedIds: () => {},
    });

    expect(order).toEqual([
      "put:DM",
      "put:C2",
      "delete:G",
      "put:G-A",
      "put:G-B",
      "delete:G-A",
      "delete:G-B",
      "put:G",
    ]);
    expect([...live].sort()).toEqual(["C2", "DM", "G"]);
    expect(result.trackedIds).toEqual(["C2", "DM", "G"]);
  });

  it("pre-prunes enough stale slots before completing a shared-predecessor expansion", async () => {
    const live = new Set(["G", "stale", "DM"]);
    const quota = live.size;
    const order: string[] = [];
    const put = async (id: string) => {
      if (!live.has(id) && live.size >= quota) throw new Error("quota exceeded");
      live.add(id);
      order.push(`put:${id}`);
    };
    const replacementGroup = {
      key: "G",
      fallbackId: "G",
      restoreFallback: (id: string) => put(id),
    };
    const result = await reconcilePushRegistrations({
      desired: [
        { id: "G-A", replaces: ["G"], register: () => put("G-A"), replacementGroup },
        { id: "G-B", replaces: ["G"], register: () => put("G-B"), replacementGroup },
        { id: "DM", register: () => put("DM") },
      ],
      trackedIds: [...live],
      deleteRegistration: async (id) => {
        live.delete(id);
        order.push(`delete:${id}`);
      },
      persistTrackedIds: () => {},
    });

    expect(order).toEqual([
      "put:DM",
      "delete:stale",
      "delete:G",
      "put:G-A",
      "put:G-B",
    ]);
    expect(result.trackedIds).toEqual(["DM", "G-A", "G-B"]);
  });

  it("rolls every sibling back on a mid-group failure and continues later records", async () => {
    const live = new Set(["G", "stale-a", "stale-b", "DM"]);
    const order: string[] = [];
    const put = async (id: string) => {
      order.push(`put:${id}`);
      if (id === "G-B") throw new Error("injected child failure");
      live.add(id);
    };
    const replacementGroup = {
      key: "G",
      fallbackId: "G",
      restoreFallback: (id: string) => put(id),
    };
    const result = await reconcilePushRegistrations({
      desired: [
        { id: "G-A", replaces: ["G"], register: () => put("G-A"), replacementGroup },
        { id: "G-B", replaces: ["G"], register: () => put("G-B"), replacementGroup },
        { id: "DM", register: () => put("DM") },
      ],
      trackedIds: [...live],
      deleteRegistration: async (id) => {
        live.delete(id);
        order.push(`delete:${id}`);
      },
      persistTrackedIds: () => {},
    });

    expect(order).toEqual([
      "put:DM",
      "delete:stale-a",
      "delete:stale-b",
      "delete:G",
      "put:G-A",
      "put:G-B",
      "delete:G-A",
      "delete:G-B",
      "put:G",
    ]);
    expect(result.trackedIds).toEqual(["DM", "G"]);
  });

  it("preserves every tracked payload during an unready partial pass", async () => {
    const live = new Set(["G-A", "G-B", "DM", "C2"]);
    const remove = vi.fn(async () => {});
    const put = vi.fn(async (id: string) => { live.add(id); });
    const replacementGroup = {
      key: "G",
      fallbackId: "G",
      fallbackIds: ["G", "G-A", "G-B"],
      restoreFallback: (id: string) => put(id),
    };
    const result = await reconcilePushRegistrations({
      desired: [
        { id: "G-A", replaces: ["G"], register: () => put("G-A"), replacementGroup },
        { id: "G-B", replaces: ["G"], register: () => put("G-B"), replacementGroup },
        { id: "DM", register: () => put("DM") },
        { id: "C2", register: () => put("C2") },
      ],
      trackedIds: [...live],
      deleteRegistration: remove,
      persistTrackedIds: () => {},
      allowPrune: false,
    });

    expect(remove).not.toHaveBeenCalled();
    // PUT is replacement, not merge: even the same tracked id could otherwise
    // shrink a last-good A+B payload to the partial snapshot's A.
    expect(put).not.toHaveBeenCalled();
    expect(result).toEqual({
      completed: true,
      trackedIds: ["C2", "DM", "G-A", "G-B"],
      failedDeletions: [],
    });
  });

  it("adds a new group child without replacing a tracked partial child", async () => {
    const putA = vi.fn(async () => {});
    const putB = vi.fn(async () => {});
    const restore = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const replacementGroup = {
      key: "G",
      fallbackId: "G",
      fallbackIds: ["G", "G-A", "G-B"],
      restoreFallback: restore,
    };

    const result = await reconcilePushRegistrations({
      desired: [
        { id: "G-A", replaces: ["G"], register: putA, replacementGroup },
        { id: "G-B", replaces: ["G"], register: putB, replacementGroup },
      ],
      trackedIds: ["G-A"],
      deleteRegistration: remove,
      persistTrackedIds: () => {},
      allowPrune: false,
    });

    expect(putA).not.toHaveBeenCalled();
    expect(putB).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(result).toEqual({
      completed: true,
      trackedIds: ["G-A", "G-B"],
      failedDeletions: [],
      registeredAny: true,
    });
  });

  it("defers an untracked partial group at quota and still refreshes DM and Concord", async () => {
    const live = new Set(["DM", "C2"]);
    const quota = live.size;
    const order: string[] = [];
    const remove = vi.fn(async () => {});
    const put = async (id: string) => {
      order.push(`put:${id}`);
      if (!live.has(id) && live.size >= quota) throw new Error("quota exceeded");
      live.add(id);
    };
    const replacementGroup = {
      key: "G",
      fallbackId: "G",
      restoreFallback: (id: string) => put(id),
    };

    const result = await reconcilePushRegistrations({
      desired: [
        { id: "G-A", replaces: ["G"], register: () => put("G-A"), replacementGroup },
        { id: "G-B", replaces: ["G"], register: () => put("G-B"), replacementGroup },
        { id: "DM", register: () => put("DM") },
        { id: "C2", register: () => put("C2") },
      ],
      trackedIds: [...live],
      deleteRegistration: remove,
      persistTrackedIds: () => {},
      allowPrune: false,
      canPruneId: (id) => id === "DM" || id === "C2",
    });

    expect(remove).not.toHaveBeenCalled();
    expect(order).toEqual(["put:DM", "put:C2", "put:G"]);
    expect(result).toEqual({
      completed: true,
      trackedIds: ["C2", "DM"],
      failedDeletions: [],
      registeredAny: true,
      deferredRegistrations: ["G", "G-A", "G-B"],
    });
    expect(live).toEqual(new Set(["DM", "C2"]));
  });

  it("pre-prunes a stale relay child for a full-quota 2-to-1 transition", async () => {
    const live = new Set(["G-A", "G-B", "DM", "C2"]);
    const quota = live.size;
    const order: string[] = [];
    const put = async (id: string) => {
      order.push(`put:${id}`);
      if (!live.has(id) && live.size >= quota) throw new Error("quota exceeded");
      live.add(id);
    };
    const replacementGroup = {
      key: "G",
      fallbackId: "G",
      restoreFallback: (id: string) => put(id),
    };

    const result = await reconcilePushRegistrations({
      desired: [
        { id: "G-A", replaces: ["G"], register: () => put("G-A"), replacementGroup },
        { id: "DM", register: () => put("DM") },
        { id: "C2", register: () => put("C2") },
      ],
      trackedIds: [...live],
      deleteRegistration: async (id) => {
        order.push(`delete:${id}`);
        live.delete(id);
      },
      persistTrackedIds: () => {},
    });

    expect(order).toEqual(["put:DM", "put:C2", "delete:G-B", "put:G-A"]);
    expect(result.trackedIds).toEqual(["C2", "DM", "G-A"]);
    expect([...live].sort()).toEqual(["C2", "DM", "G-A"]);
  });

  it("pre-prunes a stale one-relay level id before its full-quota replacement", async () => {
    const live = new Set(["G-all-A", "DM", "C2"]);
    const quota = live.size;
    const order: string[] = [];
    const put = async (id: string) => {
      order.push(`put:${id}`);
      if (!live.has(id) && live.size >= quota) throw new Error("quota exceeded");
      live.add(id);
    };
    const replacementGroup = {
      key: "G-mentions",
      fallbackId: "G-mentions",
      restoreFallback: (id: string) => put(id),
    };

    const result = await reconcilePushRegistrations({
      desired: [
        {
          id: "G-mentions-A",
          replaces: ["G-mentions"],
          register: () => put("G-mentions-A"),
          replacementGroup,
        },
        { id: "DM", register: () => put("DM") },
        { id: "C2", register: () => put("C2") },
      ],
      trackedIds: [...live],
      deleteRegistration: async (id) => {
        order.push(`delete:${id}`);
        live.delete(id);
      },
      persistTrackedIds: () => {},
    });

    expect(order).toEqual([
      "put:DM",
      "put:C2",
      "delete:G-all-A",
      "put:G-mentions-A",
    ]);
    expect(result.trackedIds).toEqual(["C2", "DM", "G-mentions-A"]);
  });

  it("pre-prunes a stale Concord relay-set id and still refreshes stable DM", async () => {
    const live = new Set(["C2-old", "DM"]);
    const quota = live.size;
    const order: string[] = [];
    const put = async (id: string) => {
      order.push(`put:${id}`);
      if (!live.has(id) && live.size >= quota) throw new Error("quota exceeded");
      live.add(id);
    };

    const result = await reconcilePushRegistrations({
      desired: [
        { id: "C2-new", register: () => put("C2-new") },
        { id: "DM", register: () => put("DM") },
      ],
      trackedIds: [...live],
      deleteRegistration: async (id) => {
        order.push(`delete:${id}`);
        live.delete(id);
      },
      persistTrackedIds: () => {},
    });

    expect(order).toEqual(["put:DM", "delete:C2-old", "put:C2-new"]);
    expect(result.trackedIds).toEqual(["C2-new", "DM"]);
  });

  it("defers a full-quota partial addition but refreshes later stable records", async () => {
    const live = new Set(["C2-old", "DM"]);
    const quota = live.size;
    const order: string[] = [];
    const remove = vi.fn(async () => {});
    const put = async (id: string) => {
      order.push(`put:${id}`);
      if (!live.has(id) && live.size >= quota) throw new Error("quota exceeded");
      live.add(id);
    };

    const result = await reconcilePushRegistrations({
      desired: [
        { id: "C2-new", register: () => put("C2-new") },
        { id: "DM", register: () => put("DM") },
        { id: "C2-old", register: () => put("C2-old") },
      ],
      trackedIds: [...live],
      deleteRegistration: remove,
      persistTrackedIds: () => {},
      allowPrune: false,
      canPruneId: (id) => id === "DM",
    });

    expect(remove).not.toHaveBeenCalled();
    expect(order).toEqual(["put:DM", "put:C2-new"]);
    expect(result).toEqual({
      completed: true,
      trackedIds: ["C2-old", "DM"],
      failedDeletions: [],
      registeredAny: true,
      deferredRegistrations: ["C2-new"],
    });
    expect(live).toEqual(new Set(["C2-old", "DM"]));
  });

  it("migrates an exact-full Concord id when only that plane is authoritative", async () => {
    const live = new Set(["C2-old"]);
    const order: string[] = [];
    const result = await reconcilePushRegistrations({
      desired: [{
        id: "C2-new",
        register: async () => {
          order.push("put:C2-new");
          if (!live.has("C2-new") && live.size >= 1) throw new Error("quota exceeded");
          live.add("C2-new");
        },
      }],
      trackedIds: [...live],
      deleteRegistration: async (id) => {
        order.push(`delete:${id}`);
        live.delete(id);
      },
      persistTrackedIds: () => {},
      allowPrune: false,
      canPruneId: (id) => id.startsWith("C2"),
    });

    expect(order).toEqual(["delete:C2-old", "put:C2-new"]);
    expect(result).toEqual({
      completed: true,
      trackedIds: ["C2-new"],
      failedDeletions: [],
      registeredAny: true,
    });
  });

  it("preserves stale ids from planes that are not authoritative", async () => {
    const removed: string[] = [];
    const result = await reconcilePushRegistrations({
      desired: [{ id: "C2-new", register: async () => {} }],
      trackedIds: ["C2-old", "DM-unready"],
      deleteRegistration: async (id) => { removed.push(id); },
      persistTrackedIds: () => {},
      allowPrune: false,
      canPruneId: (id) => id.startsWith("C2"),
    });

    expect(removed).toEqual(["C2-old"]);
    expect(result.trackedIds).toEqual(["C2-new", "DM-unready"]);
  });

  it("migrates all-to-mentions at quota when only the group plane is authoritative", async () => {
    const live = new Set(["groups-all-A"]);
    const order: string[] = [];
    const put = async (id: string) => {
      order.push(`put:${id}`);
      if (!live.has(id) && live.size >= 1) throw new Error("quota exceeded");
      live.add(id);
    };
    const replacementGroup = {
      key: "groups-mention-base",
      fallbackId: "groups-mention-base",
      restoreFallback: (id: string) => put(id),
    };
    const result = await reconcilePushRegistrations({
      desired: [{
        id: "groups-mention-A",
        replaces: ["groups-mention-base"],
        register: () => put("groups-mention-A"),
        replacementGroup,
      }],
      trackedIds: [...live],
      deleteRegistration: async (id) => {
        order.push(`delete:${id}`);
        live.delete(id);
      },
      persistTrackedIds: () => {},
      allowPrune: false,
      canPruneId: (id) => id.startsWith("groups-"),
    });

    expect(order).toEqual(["delete:groups-all-A", "put:groups-mention-A"]);
    expect(result).toEqual({
      completed: true,
      trackedIds: ["groups-mention-A"],
      failedDeletions: [],
      registeredAny: true,
    });
  });

  it("migrates at an exact-full quota by deleting each equivalent legacy id first", async () => {
    const order: string[] = [];
    const persisted: string[][] = [];
    const live = new Set(["legacy-a", "legacy-b", "unrelated-stale"]);
    const quota = live.size;

    const result = await reconcilePushRegistrations({
      desired: ["a", "b"].map((suffix) => ({
        id: `new-${suffix}`,
        replaces: [`legacy-${suffix}`],
        register: async () => {
          if (!live.has(`new-${suffix}`) && live.size >= quota) {
            throw new Error("quota exceeded");
          }
          live.add(`new-${suffix}`);
          order.push(`put:new-${suffix}`);
        },
        restoreReplaced: async (id) => { live.add(id); },
      })),
      trackedIds: ["legacy-a", "legacy-b", "unrelated-stale"],
      deleteRegistration: async (id) => {
        live.delete(id);
        order.push(`delete:${id}`);
      },
      persistTrackedIds: (ids) => { persisted.push(ids); },
    });

    expect(order).toEqual([
      "delete:unrelated-stale",
      "delete:legacy-a",
      "put:new-a",
      "delete:legacy-b",
      "put:new-b",
    ]);
    expect(result).toEqual({
      completed: true,
      trackedIds: ["new-a", "new-b"],
      failedDeletions: [],
      registeredAny: true,
    });
    expect(persisted.at(-1)).toEqual(["new-a", "new-b"]);
  });

  it("retains a failed staged legacy delete without retrying it twice", async () => {
    const remove = vi.fn(async () => { throw new Error("offline"); });
    const register = vi.fn(async () => {});
    const result = await reconcilePushRegistrations({
      desired: [{ id: "new", replaces: ["legacy"], register }],
      trackedIds: ["legacy"],
      deleteRegistration: remove,
      persistTrackedIds: () => {},
    });

    expect(result.failedDeletions).toEqual(["legacy"]);
    expect(result.trackedIds).toEqual(["legacy"]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
  });

  it("restores the legacy record when its replacement PUT fails", async () => {
    const live = new Set(["legacy"]);
    const persisted: string[][] = [];
    await expect(reconcilePushRegistrations({
      desired: [{
        id: "new",
        replaces: ["legacy"],
        register: async () => { throw new Error("gateway offline"); },
        restoreReplaced: async (id) => { live.add(id); },
      }],
      trackedIds: [...live],
      deleteRegistration: async (id) => { live.delete(id); },
      persistTrackedIds: (ids) => { persisted.push(ids); },
    })).rejects.toThrow("gateway offline");

    expect([...live]).toEqual(["legacy"]);
    expect(persisted.at(-1)).toEqual(["legacy"]);
  });

  it("keeps failed deletions durably discoverable", async () => {
    const persisted: string[][] = [];
    const result = await reconcilePushRegistrations({
      desired: [{ id: "current", register: async () => {} }],
      trackedIds: ["stale"],
      deleteRegistration: async () => { throw new Error("offline"); },
      persistTrackedIds: (ids) => { persisted.push(ids); },
    });

    expect(result.failedDeletions).toEqual(["stale"]);
    expect(result.trackedIds).toEqual(["current", "stale"]);
    expect(persisted.at(-1)).toEqual(["current", "stale"]);
  });

  it("records partial registration success before propagating a later failure", async () => {
    const persisted: string[][] = [];
    await expect(reconcilePushRegistrations({
      desired: [
        { id: "first", register: async () => {} },
        { id: "second", register: async () => { throw new Error("quota"); } },
      ],
      trackedIds: ["old"],
      deleteRegistration: async () => {},
      persistTrackedIds: (ids) => { persisted.push(ids); },
    })).rejects.toThrow("quota");

    expect(persisted.at(-1)).toEqual(["first"]);
  });

  it("never starts pruning when a stable refresh is superseded", async () => {
    let current = true;
    const remove = vi.fn(async () => {});
    const result = await reconcilePushRegistrations({
      desired: [{
        id: "stable",
        register: async () => { current = false; },
      }],
      trackedIds: ["old", "stable"],
      deleteRegistration: remove,
      persistTrackedIds: () => {},
      isCurrent: () => current,
    });

    expect(result.completed).toBe(false);
    expect(result.trackedIds).toEqual(["old", "stable"]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("adds partial snapshot registrations without pruning prior ids", async () => {
    const remove = vi.fn(async () => {});
    const persisted: string[][] = [];
    const result = await reconcilePushRegistrations({
      desired: [{ id: "currently-known", register: async () => {} }],
      trackedIds: ["not-loaded-yet"],
      deleteRegistration: remove,
      persistTrackedIds: (ids) => { persisted.push(ids); },
      allowPrune: false,
    });

    expect(result).toEqual({
      completed: true,
      trackedIds: ["currently-known", "not-loaded-yet"],
      failedDeletions: [],
      registeredAny: true,
    });
    expect(persisted.at(-1)).toEqual(["currently-known", "not-loaded-yet"]);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("LatestSerialRunner", () => {
  it("serializes workers and tells a running generation when it is stale", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maxActive = 0;
    const current: Array<[number, boolean]> = [];
    const runner = new LatestSerialRunner<number, number>(async (value, isCurrent) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (value === 1) await gate;
      current.push([value, isCurrent()]);
      active -= 1;
      return value;
    });

    const first = runner.run(1);
    await Promise.resolve();
    const second = runner.run(2);
    release();

    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(maxActive).toBe(1);
    expect(current).toEqual([[1, false], [2, true]]);
  });

  it("coalesces a queued generation that was superseded before it started", async () => {
    const worker = vi.fn(async (value: number) => value);
    const runner = new LatestSerialRunner(worker);

    const first = runner.run(1);
    const second = runner.run(2);

    expect(await first).toBeUndefined();
    expect(await second).toBe(2);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith(2, expect.any(Function));
  });
});

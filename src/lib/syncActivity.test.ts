import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginSyncTask,
  getSyncTasks,
  onSyncActivity,
  resetSyncActivity,
} from "@/lib/syncActivity";

describe("syncActivity", () => {
  beforeEach(() => {
    resetSyncActivity();
  });

  it("tracks overlapping tasks, oldest first", () => {
    const a = beginSyncTask("#general");
    const b = beginSyncTask("community updates");
    expect(getSyncTasks().map((t) => t.label)).toEqual(["#general", "community updates"]);
    a.end();
    expect(getSyncTasks().map((t) => t.label)).toEqual(["community updates"]);
    b.end();
    expect(getSyncTasks()).toEqual([]);
  });

  it("end is idempotent — double-ending can't drop another task", () => {
    const a = beginSyncTask("#general");
    const b = beginSyncTask("#random");
    a.end();
    a.end();
    a.end();
    expect(getSyncTasks().map((t) => t.label)).toEqual(["#random"]);
    b.end();
    expect(getSyncTasks()).toEqual([]);
  });

  it("update patches label/detail; updates after end are no-ops", () => {
    const a = beginSyncTask("#general");
    a.update({ detail: "84 messages" });
    expect(getSyncTasks()[0]).toMatchObject({ label: "#general", detail: "84 messages" });
    a.end();
    a.update({ detail: "ghost" });
    expect(getSyncTasks()).toEqual([]);
  });

  it("snapshot reference is stable between changes (useSyncExternalStore contract)", () => {
    const a = beginSyncTask("#general");
    const first = getSyncTasks();
    expect(getSyncTasks()).toBe(first);
    a.update({ detail: "1 message" });
    expect(getSyncTasks()).not.toBe(first);
    a.end();
  });

  it("carries an optional conversation scope", () => {
    const a = beginSyncTask("#general", { scope: "c2:abcd" });
    const b = beginSyncTask("community updates");
    expect(getSyncTasks().find((t) => t.scope === "c2:abcd")?.label).toBe("#general");
    expect(getSyncTasks().find((t) => t.label === "community updates")?.scope).toBeUndefined();
    a.end();
    b.end();
  });

  it("notifies listeners on every transition and supports unsubscribe", () => {
    const seen: number[] = [];
    const unsubscribe = onSyncActivity(() => seen.push(getSyncTasks().length));
    const a = beginSyncTask("#general");
    a.update({ detail: "1" });
    a.end();
    expect(seen).toEqual([1, 1, 0]);
    unsubscribe();
    beginSyncTask("#random");
    expect(seen).toEqual([1, 1, 0]);
  });

  it("a throwing listener doesn't break the others", () => {
    const good = vi.fn();
    onSyncActivity(() => {
      throw new Error("boom");
    });
    onSyncActivity(good);
    beginSyncTask("#general");
    expect(good).toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addServerTombstone,
  clearServerTombstone,
  getServerTombstones,
  isServerTombstoned,
  reconcileServerTombstones,
} from "@/lib/serverTombstone";

const PUBKEY = "a".repeat(64);
const OTHER = "b".repeat(64);

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("serverTombstone", () => {
  it("starts empty", () => {
    expect(getServerTombstones(PUBKEY).size).toBe(0);
    expect(isServerTombstoned(PUBKEY, "wss://relay.example")).toBe(false);
  });

  it("records and reports a tombstone (normalized)", () => {
    addServerTombstone(PUBKEY, "wss://relay.example");
    expect(isServerTombstoned(PUBKEY, "wss://relay.example")).toBe(true);
    // Trailing slash / superficial variants normalize to the same key.
    expect(isServerTombstoned(PUBKEY, "wss://relay.example/")).toBe(true);
    expect(getServerTombstones(PUBKEY).size).toBe(1);
  });

  it("persists the removal time under a pubkey-scoped key", () => {
    addServerTombstone(PUBKEY, "wss://relay.example", 1_700_000_000_000);
    const raw = localStorage.getItem(`armada-removed-servers:${PUBKEY}`);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({ "wss://relay.example": 1_700_000_000_000 });
    expect(getServerTombstones(PUBKEY).get("wss://relay.example")).toBe(1_700_000_000_000);
  });

  it("migrates the legacy array format, stamping removal as now", () => {
    const before = Date.now();
    localStorage.setItem(
      `armada-removed-servers:${PUBKEY}`,
      JSON.stringify(["wss://relay.example"]),
    );
    const entries = getServerTombstones(PUBKEY);
    expect(entries.size).toBe(1);
    expect(entries.get("wss://relay.example")).toBeGreaterThanOrEqual(before);
    // Migrated in place, so the legacy shape isn't re-parsed every read.
    expect(JSON.parse(localStorage.getItem(`armada-removed-servers:${PUBKEY}`)!))
      .toHaveProperty("wss://relay.example");
  });

  it("scopes tombstones per pubkey", () => {
    addServerTombstone(PUBKEY, "wss://relay.example");
    expect(isServerTombstoned(OTHER, "wss://relay.example")).toBe(false);
    expect(getServerTombstones(OTHER).size).toBe(0);
  });

  it("clears a single tombstone (explicit re-add case)", () => {
    addServerTombstone(PUBKEY, "wss://relay.example");
    clearServerTombstone(PUBKEY, "wss://relay.example/"); // normalized match
    expect(isServerTombstoned(PUBKEY, "wss://relay.example")).toBe(false);
    // Empty set removes the storage key entirely.
    expect(localStorage.getItem(`armada-removed-servers:${PUBKEY}`)).toBeNull();
  });

  it("reconcile keeps a tombstone when a STALE list still carries the server", () => {
    addServerTombstone(PUBKEY, "wss://relay.example", 2_000);
    // Event predates the removal → stale echo → keep vetoing.
    const pending = reconcileServerTombstones(
      PUBKEY,
      ["wss://relay.example", "wss://keep.example"],
      1_000,
    );
    expect(pending.has("wss://relay.example")).toBe(true);
    expect(isServerTombstoned(PUBKEY, "wss://relay.example")).toBe(true);
  });

  it("reconcile clears a tombstone when a NEWER list carries the server (re-added elsewhere)", () => {
    addServerTombstone(PUBKEY, "wss://relay.example", 1_000);
    const pending = reconcileServerTombstones(PUBKEY, ["wss://relay.example"], 2_000);
    expect(pending.has("wss://relay.example")).toBe(false);
    expect(isServerTombstoned(PUBKEY, "wss://relay.example")).toBe(false);
  });

  it("reconcile does NOT clear merely because a list omits the server", () => {
    // This is the regression that made removals come back: confirming the
    // removal used to delete the tombstone, leaving the next stale read
    // unopposed. Absence is not evidence of a re-add.
    addServerTombstone(PUBKEY, "wss://relay.example", 1_000);
    const pending = reconcileServerTombstones(PUBKEY, ["wss://keep.example"], 9_000);
    expect(pending.has("wss://relay.example")).toBe(true);
    expect(isServerTombstoned(PUBKEY, "wss://relay.example")).toBe(true);
  });

  it("reconcile never clears when the signal time is unknown", () => {
    addServerTombstone(PUBKEY, "wss://relay.example", 1_000);
    const pending = reconcileServerTombstones(PUBKEY, ["wss://relay.example"]);
    expect(pending.has("wss://relay.example")).toBe(true);
    expect(isServerTombstoned(PUBKEY, "wss://relay.example")).toBe(true);
  });

  it("reconcile compares by normalized url", () => {
    addServerTombstone(PUBKEY, "wss://relay.example", 1_000);
    // List carries a trailing-slash variant — same server, and it's newer.
    const pending = reconcileServerTombstones(PUBKEY, ["wss://relay.example/"], 2_000);
    expect(pending.has("wss://relay.example")).toBe(false);
  });

  it("reconcile is a no-op with no tombstones", () => {
    const pending = reconcileServerTombstones(PUBKEY, ["wss://whatever.example"], 2_000);
    expect(pending.size).toBe(0);
  });
});

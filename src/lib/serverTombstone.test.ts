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

  it("persists to localStorage under a pubkey-scoped key", () => {
    addServerTombstone(PUBKEY, "wss://relay.example");
    const raw = localStorage.getItem(`armada-removed-servers:${PUBKEY}`);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual(["wss://relay.example"]);
  });

  it("scopes tombstones per pubkey", () => {
    addServerTombstone(PUBKEY, "wss://relay.example");
    expect(isServerTombstoned(OTHER, "wss://relay.example")).toBe(false);
    expect(getServerTombstones(OTHER).size).toBe(0);
  });

  it("clears a single tombstone (re-add case)", () => {
    addServerTombstone(PUBKEY, "wss://relay.example");
    clearServerTombstone(PUBKEY, "wss://relay.example/"); // normalized match
    expect(isServerTombstoned(PUBKEY, "wss://relay.example")).toBe(false);
    // Empty set removes the storage key entirely.
    expect(localStorage.getItem(`armada-removed-servers:${PUBKEY}`)).toBeNull();
  });

  it("reconcile keeps a tombstone while the list still contains the server", () => {
    addServerTombstone(PUBKEY, "wss://relay.example");
    // Stale relay still returns the pre-removal list → removal not yet propagated.
    const pending = reconcileServerTombstones(PUBKEY, ["wss://relay.example", "wss://keep.example"]);
    expect(pending.has("wss://relay.example")).toBe(true);
    expect(isServerTombstoned(PUBKEY, "wss://relay.example")).toBe(true);
  });

  it("reconcile clears a tombstone once the list no longer contains the server", () => {
    addServerTombstone(PUBKEY, "wss://relay.example");
    // Updated list has propagated (server gone) → removal confirmed → clear.
    const pending = reconcileServerTombstones(PUBKEY, ["wss://keep.example"]);
    expect(pending.has("wss://relay.example")).toBe(false);
    expect(isServerTombstoned(PUBKEY, "wss://relay.example")).toBe(false);
  });

  it("reconcile compares by normalized url", () => {
    addServerTombstone(PUBKEY, "wss://relay.example");
    // List carries a trailing-slash variant — still the same server, keep it.
    const pending = reconcileServerTombstones(PUBKEY, ["wss://relay.example/"]);
    expect(pending.has("wss://relay.example")).toBe(true);
  });

  it("reconcile is a no-op with no tombstones", () => {
    const pending = reconcileServerTombstones(PUBKEY, ["wss://whatever.example"]);
    expect(pending.size).toBe(0);
  });
});

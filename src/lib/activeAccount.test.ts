/**
 * The account-scoped config key, and the one-time handover of the pre-scoping
 * blob.
 *
 * What these pin is the fix for a real leak: `armada:app-config` used to be a
 * single blob shared by every account on the device, and it carries the DM peer
 * maps (`startedDms`, `acceptedDms`, …) and the rail arrangement — so every
 * account saw every other account's conversations. The rules that matter are
 * that a second account cannot inherit the first's blob, and that the handover
 * happens at most once.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APP_CONFIG_STORAGE_KEY,
  accountScopedKey,
  adoptLegacyConfig,
  getActivePubkey,
  seedAccountConfig,
  setActivePubkey,
  subscribeActivePubkey,
  _resetActiveAccountForTests,
} from "./activeAccount";

const A = "a".repeat(64);
const B = "b".repeat(64);
const BASE = APP_CONFIG_STORAGE_KEY;

beforeEach(() => {
  localStorage.clear();
  _resetActiveAccountForTests();
});

afterEach(() => {
  localStorage.clear();
  _resetActiveAccountForTests();
});

describe("accountScopedKey", () => {
  it("appends the pubkey, and leaves the base key alone when logged out", () => {
    expect(accountScopedKey(BASE, A)).toBe(`${BASE}:${A}`);
    expect(accountScopedKey(BASE, null)).toBe(BASE);
  });

  it("gives two accounts different keys", () => {
    expect(accountScopedKey(BASE, A)).not.toBe(accountScopedKey(BASE, B));
  });
});

describe("the active-pubkey marker", () => {
  it("round-trips through localStorage so the next boot reads it synchronously", () => {
    setActivePubkey(A);
    expect(getActivePubkey()).toBe(A);
    // A fresh module load (simulated) picks it up with no async read.
    _resetActiveAccountForTests();
    expect(getActivePubkey()).toBe(A);
  });

  it("clears on logout", () => {
    setActivePubkey(A);
    setActivePubkey(null);
    expect(getActivePubkey()).toBeNull();
    _resetActiveAccountForTests();
    expect(getActivePubkey()).toBeNull();
  });

  it("notifies subscribers, and only on a real change", () => {
    let calls = 0;
    const unsubscribe = subscribeActivePubkey(() => {
      calls += 1;
    });
    setActivePubkey(A);
    expect(calls).toBe(1);
    setActivePubkey(A);
    expect(calls).toBe(1);
    setActivePubkey(B);
    expect(calls).toBe(2);
    unsubscribe();
    setActivePubkey(A);
    expect(calls).toBe(2);
  });
});

describe("adoptLegacyConfig", () => {
  it("hands the pre-scoping blob to the first account that asks", () => {
    localStorage.setItem(BASE, JSON.stringify({ theme: "light" }));

    adoptLegacyConfig(BASE, A);

    expect(JSON.parse(localStorage.getItem(accountScopedKey(BASE, A))!)).toEqual({ theme: "light" });
  });

  // The whole point. Before scoping, this blob held A's DM peer list; B must
  // start from defaults and fill in from its OWN settings documents.
  it("refuses to hand the same blob to a second account", () => {
    localStorage.setItem(BASE, JSON.stringify({ startedDms: { peer: 1 } }));

    adoptLegacyConfig(BASE, A);
    adoptLegacyConfig(BASE, B);

    expect(localStorage.getItem(accountScopedKey(BASE, B))).toBeNull();
  });

  it("does not re-adopt over an account's own edits", () => {
    localStorage.setItem(BASE, JSON.stringify({ theme: "light" }));
    adoptLegacyConfig(BASE, A);
    localStorage.setItem(accountScopedKey(BASE, A), JSON.stringify({ theme: "dark" }));

    adoptLegacyConfig(BASE, A);

    expect(JSON.parse(localStorage.getItem(accountScopedKey(BASE, A))!)).toEqual({ theme: "dark" });
  });

  it("is a no-op when there is nothing to adopt", () => {
    adoptLegacyConfig(BASE, A);
    expect(localStorage.getItem(accountScopedKey(BASE, A))).toBeNull();
  });
});

describe("seedAccountConfig", () => {
  it("writes into the target account's key, not the active one", () => {
    setActivePubkey(A);
    localStorage.setItem(accountScopedKey(BASE, A), JSON.stringify({ appRelays: ["wss://a"] }));

    seedAccountConfig(BASE, B, { appRelays: ["wss://b"] });

    expect(JSON.parse(localStorage.getItem(accountScopedKey(BASE, B))!)).toEqual({
      appRelays: ["wss://b"],
    });
    // A is untouched — the signup wizard used to write these through
    // `updateConfig`, which meant into whoever was signed in at the time.
    expect(JSON.parse(localStorage.getItem(accountScopedKey(BASE, A))!)).toEqual({
      appRelays: ["wss://a"],
    });
  });

  it("merges over existing fields rather than replacing the blob", () => {
    localStorage.setItem(accountScopedKey(BASE, A), JSON.stringify({ theme: "light", appRelays: [] }));

    seedAccountConfig(BASE, A, { appRelays: ["wss://a"] });

    expect(JSON.parse(localStorage.getItem(accountScopedKey(BASE, A))!)).toEqual({
      theme: "light",
      appRelays: ["wss://a"],
    });
  });

  it("adopts the legacy blob first, so a first account keeps pre-login choices", () => {
    localStorage.setItem(BASE, JSON.stringify({ theme: "light" }));

    seedAccountConfig(BASE, A, { appRelays: ["wss://a"] });

    expect(JSON.parse(localStorage.getItem(accountScopedKey(BASE, A))!)).toEqual({
      theme: "light",
      appRelays: ["wss://a"],
    });
  });

  it("survives a corrupt stored blob", () => {
    localStorage.setItem(accountScopedKey(BASE, A), "{not json");

    seedAccountConfig(BASE, A, { appRelays: ["wss://a"] });

    expect(JSON.parse(localStorage.getItem(accountScopedKey(BASE, A))!)).toEqual({
      appRelays: ["wss://a"],
    });
  });
});

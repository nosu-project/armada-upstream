import { describe, expect, it, vi } from "vitest";

import { mergeAccounts } from "@/hooks/useLoggedInAccounts";

import type { NostrEvent } from "@nostrify/nostrify";

// Regression test for the account-switcher losing names/avatars on reload /
// flaky connection. The hook used to resolve each login from a SINGLE
// tight-timeout relay query with no cache fallback, so a slow/empty/offline
// read collapsed accounts to bare pubkeys. mergeAccounts now uses the cache as
// a floor: fresh relay event → previous result → local store → empty.

const PK1 = "1".repeat(64);
const PK2 = "2".repeat(64);

function kind0(pubkey: string, name: string): NostrEvent {
  return {
    id: `${name}`.padEnd(64, "0").slice(0, 64),
    pubkey,
    created_at: 1000,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name }),
    sig: "f".repeat(128),
  };
}

const logins = [
  { id: "login-1", pubkey: PK1 },
  { id: "login-2", pubkey: PK2 },
];

const noCache = vi.fn(async () => undefined);

describe("mergeAccounts (account-switcher cache floor)", () => {
  it("uses fresh relay events when present", async () => {
    const fresh = [kind0(PK1, "Alice"), kind0(PK2, "Bob")];
    const accounts = await mergeAccounts(logins, fresh, [], noCache);
    expect(accounts.map((a) => a.metadata.name)).toEqual(["Alice", "Bob"]);
    expect(noCache).not.toHaveBeenCalled();
  });

  it("falls back to the previous result when the relay returns NOTHING", async () => {
    const prev = [
      { id: "login-1", pubkey: PK1, metadata: { name: "Alice" }, event: kind0(PK1, "Alice") },
      { id: "login-2", pubkey: PK2, metadata: { name: "Bob" }, event: kind0(PK2, "Bob") },
    ];
    // Empty relay read must NOT blank the accounts.
    const accounts = await mergeAccounts(logins, [], prev, noCache);
    expect(accounts.map((a) => a.metadata.name)).toEqual(["Alice", "Bob"]);
  });

  it("falls back to the local store when relay misses and there's no prior result", async () => {
    const cachedFor = vi.fn(async (pk: string) => (pk === PK1 ? kind0(PK1, "CachedAlice") : undefined));
    const accounts = await mergeAccounts(logins, [], [], cachedFor);
    expect(accounts[0].metadata.name).toBe("CachedAlice");
    expect(accounts[1].metadata).toEqual({}); // PK2 unknown everywhere → empty, not dropped
    expect(accounts.map((a) => a.pubkey)).toEqual([PK1, PK2]); // never drops a login
  });

  it("prefers fresh over cache, and cache only for the missed logins", async () => {
    const fresh = [kind0(PK1, "FreshAlice")]; // PK2 missing from relay
    const cachedFor = vi.fn(async (pk: string) => (pk === PK2 ? kind0(PK2, "CachedBob") : undefined));
    const accounts = await mergeAccounts(logins, fresh, [], cachedFor);
    expect(accounts.map((a) => a.metadata.name)).toEqual(["FreshAlice", "CachedBob"]);
    // Cache consulted only for the missed login (PK2), not PK1.
    expect(cachedFor).toHaveBeenCalledTimes(1);
    expect(cachedFor).toHaveBeenCalledWith(PK2);
  });

  it("a fresh event overrides a stale previous result", async () => {
    const prev = [{ id: "login-1", pubkey: PK1, metadata: { name: "OldAlice" }, event: kind0(PK1, "OldAlice") }];
    const fresh = [kind0(PK1, "NewAlice")];
    const accounts = await mergeAccounts([logins[0]], fresh, prev, noCache);
    expect(accounts[0].metadata.name).toBe("NewAlice");
  });

  it("preserves login order and never drops a login", async () => {
    const accounts = await mergeAccounts(logins, [], [], noCache);
    expect(accounts.map((a) => a.id)).toEqual(["login-1", "login-2"]);
  });
});

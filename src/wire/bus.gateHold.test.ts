import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitWireScopes, onWireScopes, resetWireBus, setWireGateHold } from "./bus";

/**
 * The SyncGate doorbell hold (`setWireGateHold`).
 *
 * While the full-screen post-login overlay is up, every LOCAL subscriber that
 * re-reads the store on a doorbell — the rail's unread badges (items, folder
 * rollups, pinned DMs) and any occluded timeline — is hidden behind it, so the
 * warm-up ringing them is invisible work that still re-renders the shell. The
 * bus therefore HOLDS those doorbells while gated and delivers them once, as a
 * single coalesced batch, when the gate lifts.
 *
 * The exception is load-bearing: the in-hand-work scopes (`dm:wrap`,
 * `c2inv:wrap`, `c2park:*`) are login-time INGEST — force-syncing a live wrap,
 * draining a parked stream — not a re-render, and must flow immediately even
 * under the hold, or a message arriving during login is never decrypted.
 */

const flushBus = async () => {
  await vi.advanceTimersByTimeAsync(60); // past the 50ms coalescing window
};

let batches: Array<string[]>;
let unsub: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  resetWireBus();
  batches = [];
  unsub = onWireScopes((scopes) => batches.push([...scopes].sort()));
});

afterEach(() => {
  unsub();
  resetWireBus();
  vi.useRealTimers();
});

describe("wire bus gate hold", () => {
  it("holds doorbells while gated and delivers them once on release", async () => {
    setWireGateHold(true);

    emitWireScopes(["c2:aaa", "dm"]);
    await flushBus();
    emitWireScopes(["c2:aaa", "nip29:g1", "c2ctl:aaa"]);
    await flushBus();

    // Nothing delivered locally while the overlay is up.
    expect(batches).toEqual([]);

    setWireGateHold(false);

    // One coalesced batch, deduped across the two held bursts.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(["c2:aaa", "c2ctl:aaa", "dm", "nip29:g1"].sort());
  });

  it("passes in-hand-work scopes through immediately, even while gated", async () => {
    setWireGateHold(true);

    emitWireScopes(["c2:aaa", "dm:wrap", "c2park:pk1", "c2inv:wrap"]);
    await flushBus();

    // The ingest scopes arrive now; the doorbell (`c2:aaa`) is held.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(["c2inv:wrap", "c2park:pk1", "dm:wrap"].sort());

    setWireGateHold(false);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(["c2:aaa"]);
  });

  it("delivers normally when not gated", async () => {
    emitWireScopes(["c2:aaa", "dm"]);
    await flushBus();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(["c2:aaa", "dm"].sort());
  });

  it("releasing with nothing held delivers nothing", async () => {
    setWireGateHold(true);
    setWireGateHold(false);
    await flushBus();
    expect(batches).toEqual([]);
  });
});

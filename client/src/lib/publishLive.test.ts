import type { NostrEvent } from "@nostrify/nostrify";
import { describe, expect, it, vi } from "vitest";

import { publishLive } from "@/lib/publishLive";

/** WebSocket.readyState constants. */
const CONNECTING = 0;
const OPEN = 1;

/** A fake websocket-ts socket with a settable readyState and an open event. */
function makeSocket(readyState: number) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    readyState,
    addEventListener(type: string, listener: () => void) {
      const arr = listeners.get(type) ?? [];
      arr.push(listener);
      listeners.set(type, arr);
    },
    removeEventListener(type: string, listener: () => void) {
      const arr = listeners.get(type);
      if (arr) listeners.set(type, arr.filter((l) => l !== listener));
    },
    /** Test helper: transition to OPEN and fire the "open" listeners. */
    fireOpen() {
      this.readyState = OPEN;
      for (const l of listeners.get("open") ?? []) l();
    },
  };
}

function makeRelay(readyState: number) {
  const socket = makeSocket(readyState);
  const event = vi.fn(async () => {});
  return { socket, event };
}

const EVENT = { id: "abc", kind: 9, pubkey: "p", sig: "s", tags: [], content: "", created_at: 1 } as NostrEvent;

describe("publishLive", () => {
  it("sends directly when the socket is already OPEN (no reconnect)", async () => {
    const relay = makeRelay(OPEN);
    const pool = {
      relay: vi.fn(() => relay),
      relays: new Map([["wss://r", relay]]),
    };

    await publishLive(pool as never, "wss://r", EVENT, {
      signal: AbortSignal.timeout(1000),
      timeoutMs: 1000,
    });

    expect(relay.event).toHaveBeenCalledOnce();
    // Never dropped/recreated a healthy relay.
    expect(pool.relays.has("wss://r")).toBe(true);
    expect(pool.relay).toHaveBeenCalledTimes(1);
  });

  it("drops the stale relay and forces a fresh one when the socket is not OPEN", async () => {
    const stale = makeRelay(CONNECTING);
    const fresh = makeRelay(OPEN);
    const relays = new Map([["wss://r", stale]]);
    const pool = {
      relay: vi.fn((url: string) => {
        // Mirror NPool.relay(): return the cached entry, else build + cache one.
        const cached = relays.get(url);
        if (cached) return cached;
        relays.set(url, fresh);
        return fresh;
      }),
      relays,
    };

    await publishLive(pool as never, "wss://r", EVENT, {
      signal: AbortSignal.timeout(1000),
      timeoutMs: 1000,
    });

    // Stale never used to send; the fresh (open) relay did.
    expect(stale.event).not.toHaveBeenCalled();
    expect(fresh.event).toHaveBeenCalledOnce();
    // The pool now holds the fresh relay under the URL.
    expect(relays.get("wss://r")).toBe(fresh);
  });

  it("waits for a freshly-forced socket to open before sending", async () => {
    const stale = makeRelay(CONNECTING);
    const fresh = makeRelay(CONNECTING); // not open yet
    const relays = new Map([["wss://r", stale]]);
    const pool = {
      relay: vi.fn((url: string) => {
        const cached = relays.get(url);
        if (cached) return cached;
        relays.set(url, fresh);
        return fresh;
      }),
      relays,
    };

    const done = vi.fn();
    const promise = publishLive(pool as never, "wss://r", EVENT, {
      signal: AbortSignal.timeout(5000),
      timeoutMs: 5000,
    }).then(done);

    // Not sent yet: the fresh socket hasn't opened.
    await Promise.resolve();
    expect(fresh.event).not.toHaveBeenCalled();

    // Once the socket opens, the send proceeds.
    fresh.socket.fireOpen();
    await promise;
    expect(fresh.event).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalled();
  });
});

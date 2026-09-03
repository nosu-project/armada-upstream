/**
 * The bus's cross-context doorbell: same-origin contexts share the store, so a
 * batch flushed in one must ring the others — the one in-process case the local
 * emit can't cover (another tab's own send, its expiry sweep's deletions), and
 * the gap the rail's removed per-community refetch backstop used to paper over.
 *
 * Node's BroadcastChannel delivers between same-named instances on one thread,
 * which is exactly the shape of two tabs to this module: the bus's own channel
 * is one instance, each `peer()` below is another tab's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { emitWireScopes, onWireScopes, resetWireBus } from "./bus";

const openPeers: BroadcastChannel[] = [];

/** Another tab's end of the doorbell: same channel name, collected messages. */
function peer(): { received: unknown[]; post: (scopes: string[]) => void } {
  const channel = new BroadcastChannel("armada-wire-bus");
  (channel as { unref?: () => void }).unref?.();
  openPeers.push(channel);
  const received: unknown[] = [];
  channel.onmessage = (event: MessageEvent) => {
    received.push(event.data);
  };
  return { received, post: (scopes) => channel.postMessage(scopes) };
}

/** Collect local bus deliveries; unsubscribed by resetWireBus in afterEach. */
function localListener(): Set<string> {
  const seen = new Set<string>();
  onWireScopes((scopes) => {
    for (const s of scopes) seen.add(s);
  });
  return seen;
}

afterEach(() => {
  resetWireBus();
  for (const channel of openPeers.splice(0)) channel.close();
});

describe("wire bus — cross-context doorbell", () => {
  it("mirrors a flushed batch to other contexts", async () => {
    const other = peer();

    emitWireScopes(["c2:abc", "dm"]);

    await vi.waitFor(() => expect(other.received.length).toBeGreaterThan(0));
    expect(other.received).toHaveLength(1);
    expect(new Set(other.received[0] as string[])).toEqual(new Set(["c2:abc", "dm"]));
  });

  it("delivers a received batch to local listeners", async () => {
    const seen = localListener();

    peer().post(["nip29:g1", "c2:def"]);

    await vi.waitFor(() => expect(seen.has("nip29:g1")).toBe(true));
    expect(seen.has("c2:def")).toBe(true);
  });

  it("does not rebroadcast a received batch", async () => {
    // The sender's own channel never hears its own post, so anything arriving
    // back at it can only be a rebroadcast — the two-tab ping-pong loop.
    const sender = peer();
    const seen = localListener();

    sender.post(["c2:loop"]);
    await vi.waitFor(() => expect(seen.has("c2:loop")).toBe(true));

    // Let a full coalescing window pass beyond the local delivery.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sender.received).toHaveLength(0);
  });

  it("keeps in-hand action scopes off the wire, and everything local", async () => {
    const other = peer();
    const seen = localListener();

    // The three action scopes trigger work on an event only THIS context holds
    // (a buffered wrap, a parked stream); mirroring them would make every tab
    // force-sync the same wrap. The store-changed scope still crosses.
    emitWireScopes(["dm:wrap", "c2inv:wrap", "c2park:pk1", "c2:xyz"]);

    await vi.waitFor(() => expect(other.received.length).toBeGreaterThan(0));
    expect(other.received[0]).toEqual(["c2:xyz"]);
    for (const s of ["dm:wrap", "c2inv:wrap", "c2park:pk1", "c2:xyz"]) {
      expect(seen.has(s)).toBe(true);
    }
  });

  it("posts nothing for a batch of only in-hand action scopes", async () => {
    const other = peer();
    const seen = localListener();

    emitWireScopes(["dm:wrap", "c2park:pk2"]);

    await vi.waitFor(() => expect(seen.has("dm:wrap")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(other.received).toHaveLength(0);
  });
});

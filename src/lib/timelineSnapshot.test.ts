import { beforeEach, describe, expect, it } from "vitest";

import {
  dmThreadSnapshotScope,
  nip29SnapshotScope,
  readTimelineSnapshot,
  writeTimelineSnapshot,
} from "@/lib/timelineSnapshot";

interface FakeMsg {
  id: string;
  created_at: number;
  content: string;
}

function msgs(n: number, offset = 0): FakeMsg[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${offset + i}`,
    created_at: offset + i,
    content: `msg ${offset + i}`,
  }));
}

describe("timelineSnapshot", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a timeline", () => {
    const scope = nip29SnapshotScope("wss://relay.example", "group1");
    const items = msgs(5);
    writeTimelineSnapshot(scope, items);
    expect(readTimelineSnapshot<FakeMsg>(scope)).toEqual(items);
  });

  it("returns undefined on miss / empty / undefined scope", () => {
    expect(readTimelineSnapshot("nope")).toBeUndefined();
    expect(readTimelineSnapshot(undefined)).toBeUndefined();
    writeTimelineSnapshot(undefined, msgs(3)); // no-op, no throw
    writeTimelineSnapshot("scope", []); // empty is a no-op
    expect(readTimelineSnapshot("scope")).toBeUndefined();
  });

  it("keeps only the newest items (tail slice)", () => {
    const scope = "test:abcd";
    writeTimelineSnapshot(scope, msgs(50));
    const read = readTimelineSnapshot<FakeMsg>(scope)!;
    expect(read.length).toBe(30);
    // Oldest-first order preserved; newest retained.
    expect(read[0].id).toBe("id-20");
    expect(read[read.length - 1].id).toBe("id-49");
  });

  it("round-trips Uint8Array and bigint fields (Concord shapes)", () => {
    const scope = "test:beef";
    const item = {
      messageId: "m1",
      channelId: new Uint8Array([1, 2, 3]),
      epoch: 42n,
      ms: 1000,
    };
    writeTimelineSnapshot(scope, [item]);
    const [read] = readTimelineSnapshot<typeof item>(scope)!;
    expect(read.channelId).toBeInstanceOf(Uint8Array);
    expect([...read.channelId]).toEqual([1, 2, 3]);
    expect(read.epoch).toBe(42n);
  });

  it("evicts least-recently-written scopes beyond the shared budget", () => {
    // Fill past MAX_SCOPES (16) across transports.
    for (let i = 0; i < 18; i++) {
      writeTimelineSnapshot(dmThreadSnapshotScope("self", `peer-${i}`), msgs(1, i));
    }
    // The two oldest are evicted.
    expect(readTimelineSnapshot(dmThreadSnapshotScope("self", "peer-0"))).toBeUndefined();
    expect(readTimelineSnapshot(dmThreadSnapshotScope("self", "peer-1"))).toBeUndefined();
    // Newest survive.
    expect(readTimelineSnapshot(dmThreadSnapshotScope("self", "peer-17"))).toBeDefined();
  });

  it("re-writing an existing scope bumps it in the LRU instead of duplicating", () => {
    const hot = nip29SnapshotScope("wss://r", "hot");
    writeTimelineSnapshot(hot, msgs(1));
    for (let i = 0; i < 15; i++) {
      writeTimelineSnapshot(nip29SnapshotScope("wss://r", `g${i}`), msgs(1));
    }
    // Bump `hot`, then push one more scope over the budget: the eviction must
    // hit the oldest cold scope, not `hot`.
    writeTimelineSnapshot(hot, msgs(2));
    writeTimelineSnapshot(nip29SnapshotScope("wss://r", "last"), msgs(1));
    expect(readTimelineSnapshot(hot)).toBeDefined();
    expect(readTimelineSnapshot(nip29SnapshotScope("wss://r", "g0"))).toBeUndefined();
  });
});

/**
 * The plaintext ingest path drops copies of events it has already stored.
 *
 * A live measurement of an idle client found 72% of kind-0 deliveries, 74% of
 * kind-4 and 93% of the NIP-34 git kinds were duplicates: the wire re-REQs on
 * a quiet rotation with a backward `since` overlap, and one filter fans out to
 * every relay carrying it. The store dedupes by id, but only after the write
 * reaches it, so each copy still cost a store round-trip and — the expensive
 * part — re-emitted its scope, which is what drives the React Query
 * invalidations downstream.
 *
 * The one thing these tests exist to protect is the NIP-29 exception: a
 * relay-scoped event is filed per relay tenant, so the same id from a second
 * relay is a different row and must NOT be deduped away.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { NostrEvent } from "@nostrify/nostrify";

import { _resetIngestDedupeForTests, ingestWireEvents, type WireSinks } from "@/wire/ingest";
import { onWireScopes, resetWireBus } from "@/wire/bus";

/** A kind-0 profile: not relay-scoped, so it dedupes on id alone. */
function profile(n: number, pubkey = "ab".repeat(32)): NostrEvent {
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    created_at: 1_700_000_000 + n,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: `user ${n}` }),
    sig: "cd".repeat(64),
  };
}

/** A NIP-29 group chat message: relay-scoped via its `h` tag. */
function groupChat(n: number, groupId = "g1"): NostrEvent {
  return {
    id: (n + 0x1000).toString(16).padStart(64, "0"),
    pubkey: "ab".repeat(32),
    created_at: 1_700_000_000 + n,
    kind: 9,
    tags: [["h", groupId]],
    content: `message ${n}`,
    sig: "cd".repeat(64),
  };
}

interface Recorded {
  event: NostrEvent;
  relay: string | undefined;
}

const SELF = "ff".repeat(32);
const PEER = "ab".repeat(32);

/** A legacy NIP-04 DM: names its own `dm:<peer>` scope without a WireSpec. */
function dm(n: number): NostrEvent {
  return {
    id: (n + 0x2000).toString(16).padStart(64, "0"),
    pubkey: PEER,
    created_at: 1_700_000_000 + n,
    kind: 4,
    tags: [["p", SELF]],
    content: "ciphertext",
    sig: "cd".repeat(64),
  };
}

function makeSinks(): { sinks: WireSinks; writes: Recorded[]; fail: Set<string> } {
  const writes: Recorded[] = [];
  const fail = new Set<string>();
  const store = {
    event(event: NostrEvent, opts?: { relay?: string }) {
      if (fail.has(event.id)) return Promise.reject(new Error("store rejected"));
      writes.push({ event, relay: opts?.relay });
      return Promise.resolve();
    },
    query: () => Promise.resolve([]),
  };
  return {
    writes,
    fail,
    sinks: {
      eventStore: Promise.resolve(store as unknown as WireSinks["eventStore"] extends Promise<infer S> ? S : never),
      getSpec: () => undefined,
      getSelfPubkey: () => SELF,
    },
  };
}

describe("plaintext ingest dedupe", () => {
  beforeEach(() => {
    _resetIngestDedupeForTests();
    resetWireBus();
  });

  it("writes an event once when the same delivery repeats", async () => {
    const { sinks, writes } = makeSinks();
    await ingestWireEvents(sinks, [profile(1)], { relay: "wss://a.example" });
    await ingestWireEvents(sinks, [profile(1)], { relay: "wss://a.example" });
    expect(writes).toHaveLength(1);
  });

  it("drops a duplicate carried twice inside ONE batch", async () => {
    const { sinks, writes } = makeSinks();
    await ingestWireEvents(sinks, [profile(1), profile(1)], { relay: "wss://a.example" });
    expect(writes).toHaveLength(1);
  });

  it("dedupes a non-relay-scoped event ACROSS relays", async () => {
    // The 93% git / 72% profile case: the same event from every relay that
    // carries it. These all land in the `main` tenant, so one write is right.
    const { sinks, writes } = makeSinks();
    await ingestWireEvents(sinks, [profile(1)], { relay: "wss://a.example" });
    await ingestWireEvents(sinks, [profile(1)], { relay: "wss://b.example" });
    await ingestWireEvents(sinks, [profile(1)], { relay: "wss://c.example" });
    expect(writes).toHaveLength(1);
  });

  it("does NOT dedupe a relay-scoped event across relays", async () => {
    // A NIP-29 event is filed per relay tenant: the same `h` value on two
    // relays is two unrelated groups, so both rows must be written.
    const { sinks, writes } = makeSinks();
    await ingestWireEvents(sinks, [groupChat(1)], { relay: "wss://a.example" });
    await ingestWireEvents(sinks, [groupChat(1)], { relay: "wss://b.example" });
    expect(writes).toHaveLength(2);
    expect(writes.map((w) => w.relay)).toEqual(["wss://a.example", "wss://b.example"]);
  });

  it("still dedupes a relay-scoped event's replay from the SAME relay", async () => {
    const { sinks, writes } = makeSinks();
    await ingestWireEvents(sinks, [groupChat(1)], { relay: "wss://a.example" });
    await ingestWireEvents(sinks, [groupChat(1)], { relay: "wss://a.example" });
    expect(writes).toHaveLength(1);
  });

  it("lets a NEW version of a replaceable event through", async () => {
    // A profile edit is a different event id, so the memo never hides it.
    const { sinks, writes } = makeSinks();
    await ingestWireEvents(sinks, [profile(1)], { relay: "wss://a.example" });
    await ingestWireEvents(sinks, [profile(2)], { relay: "wss://a.example" });
    expect(writes).toHaveLength(2);
  });

  it("emits the scope only for the first delivery", async () => {
    // The point of the change: a duplicate must not re-ring the bus, because a
    // scope is what re-runs the query invalidations downstream.
    const { sinks } = makeSinks();
    const rings: ReadonlySet<string>[] = [];
    const unsub = onWireScopes((scopes) => rings.push(scopes));
    // The bus coalesces a burst behind a 50ms timer (bus.ts FLUSH_MS), so the
    // doorbell has to be given time to ring before it is counted.
    const settle = () => new Promise((r) => setTimeout(r, 80));
    try {
      await ingestWireEvents(sinks, [dm(1)], { relay: "wss://a.example" });
      await settle();
      const afterFirst = rings.length;
      expect(afterFirst).toBeGreaterThan(0);
      await ingestWireEvents(sinks, [dm(1)], { relay: "wss://a.example" });
      await settle();
      expect(rings.length).toBe(afterFirst);
    } finally {
      unsub();
    }
  });

  it("retries an event whose write failed", async () => {
    // Marked before the write, unmarked on throw — a failed write must not be
    // deduped against a row that never landed.
    const { sinks, writes, fail } = makeSinks();
    fail.add(profile(1).id);
    await ingestWireEvents(sinks, [profile(1)], { relay: "wss://a.example" });
    expect(writes).toHaveLength(0);
    fail.clear();
    await ingestWireEvents(sinks, [profile(1)], { relay: "wss://a.example" });
    expect(writes).toHaveLength(1);
  });
});

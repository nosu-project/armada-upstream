import { afterEach, describe, expect, it } from "vitest";

import { purgeArmadaDB } from "@/lib/db/armadaDB";
import {
  __resetOutboxForTests,
  clearPublishOutbox,
  getQueuedPublishes,
  markQueuedPublishFailure,
  queueSignedEvent,
  removeQueuedPublish,
  withSignature,
} from "@/lib/publishOutbox";

import type { NostrEvent } from "@nostrify/nostrify";

const PK = "a".repeat(64);

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const kind = overrides.kind ?? 1;
  const created_at = overrides.created_at ?? 1000;
  const id = overrides.id ?? `${kind}-${created_at}`.padEnd(64, "0").slice(0, 64);
  return {
    id,
    pubkey: overrides.pubkey ?? PK,
    created_at,
    kind,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "",
    sig: overrides.sig ?? "f".repeat(128),
  };
}

// The outbox lives in ArmadaDB's KV, reached through a module-level singleton,
// so isolation means purging it rather than swapping the IndexedDB factory.
afterEach(async () => {
  await purgeArmadaDB();
  localStorage.removeItem("armada:publish-outbox");
  __resetOutboxForTests();
});

describe("publish outbox", () => {
  it("queues signed events and removes them after publish", async () => {
    const ev = event();
    await queueSignedEvent(ev);
    expect((await getQueuedPublishes()).map((item) => item.id)).toEqual([ev.id]);

    await removeQueuedPublish(ev.id);
    expect(await getQueuedPublishes()).toEqual([]);
  });

  it("does not duplicate the same event id", async () => {
    const ev = event();
    await queueSignedEvent(ev);
    await queueSignedEvent(ev);
    expect(await getQueuedPublishes()).toHaveLength(1);
  });

  it("keeps only the newest queued replaceable profile event", async () => {
    const older = event({ kind: 0, created_at: 100, content: JSON.stringify({ name: "old" }) });
    const newer = event({ kind: 0, created_at: 200, content: JSON.stringify({ name: "new" }) });

    await queueSignedEvent(older);
    await queueSignedEvent(newer);

    const queued = await getQueuedPublishes();
    expect(queued).toHaveLength(1);
    expect(queued[0].event.content).toBe(newer.content);
  });

  it("does not replace a newer replaceable event with an older one", async () => {
    const newer = event({ kind: 0, created_at: 200, content: JSON.stringify({ name: "new" }) });
    const older = event({ kind: 0, created_at: 100, content: JSON.stringify({ name: "old" }) });

    await queueSignedEvent(newer);
    await queueSignedEvent(older);

    const queued = await getQueuedPublishes();
    expect(queued).toHaveLength(1);
    expect(queued[0].event.content).toBe(newer.content);
  });

  it("records retry state after a failed publish attempt", async () => {
    const ev = event();
    await queueSignedEvent(ev);
    await markQueuedPublishFailure(ev.id, new Error("offline"));

    const [queued] = await getQueuedPublishes();
    expect(queued.attempts).toBe(1);
    expect(queued.lastError).toBe("offline");
    expect(queued.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it("clears the whole queue", async () => {
    await queueSignedEvent(event({ created_at: 1 }));
    await queueSignedEvent(event({ created_at: 2 }));
    expect(await getQueuedPublishes()).toHaveLength(2);

    await clearPublishOutbox();
    expect(await getQueuedPublishes()).toEqual([]);
  });

  it("returns entries oldest-first, not in event-id order", async () => {
    // Ids sort the other way round, so key order alone would reverse these.
    const first = event({ id: "f".repeat(64), created_at: 1 });
    const second = event({ id: "0".repeat(64), created_at: 2 });

    await queueSignedEvent(first);
    await new Promise((r) => setTimeout(r, 2));
    await queueSignedEvent(second);

    expect((await getQueuedPublishes()).map((i) => i.id)).toEqual([first.id, second.id]);
  });

  it("does not queue an event whose signature is missing", async () => {
    // It could never be delivered, so it is not a valid entry.
    await queueSignedEvent(event({ sig: "" }));
    expect(await getQueuedPublishes()).toEqual([]);
  });

  describe("withSignature", () => {
    it("restores the signature of an event that lost it", async () => {
      const ev = event();
      await queueSignedEvent(ev);

      // What a timeline fed from the event store hands back.
      const unsigned = { ...ev, sig: "" };
      expect((await withSignature(unsigned)).sig).toBe(ev.sig);
    });

    it("returns a signed event untouched, and an unknown one unchanged", async () => {
      const ev = event();
      expect(await withSignature(ev)).toBe(ev);

      const orphan = { ...event({ created_at: 9 }), sig: "" };
      expect((await withSignature(orphan)).sig).toBe("");
    });
  });

  describe("migration from localStorage", () => {
    it("drains the legacy queue on first access and clears the old key", async () => {
      const ev = event();
      localStorage.setItem(
        "armada:publish-outbox",
        JSON.stringify([{ id: ev.id, event: ev, enqueuedAt: 5, attempts: 0 }]),
      );

      const queued = await getQueuedPublishes();
      expect(queued.map((i) => i.id)).toEqual([ev.id]);
      expect(queued[0].event.sig).toBe(ev.sig);
      expect(localStorage.getItem("armada:publish-outbox")).toBeNull();
    });

    it("survives a malformed legacy payload", async () => {
      localStorage.setItem("armada:publish-outbox", "not json");
      expect(await getQueuedPublishes()).toEqual([]);
    });
  });
});

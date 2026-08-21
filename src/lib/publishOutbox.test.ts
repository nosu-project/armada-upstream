import { afterEach, describe, expect, it, vi } from "vitest";

import { getArmadaDB, purgeArmadaDB } from "@/lib/db/armadaDB";
import {
  __resetOutboxForTests,
  clearPublishOutbox,
  getQueuedPublishes,
  markQueuedPublishFailure,
  queueSignedEvent,
  recordQueuedPublishAttempt,
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

  it("retains only the explicit relay destinations that still need delivery", async () => {
    const ev = event();
    await queueSignedEvent(ev, undefined, ["wss://one.example", "wss://two.example"]);

    await recordQueuedPublishAttempt(
      ev.id,
      ["wss://one.example", "wss://two.example"],
      ["wss://two.example"],
    );
    expect((await getQueuedPublishes())[0].relays).toEqual(["wss://two.example"]);

    await recordQueuedPublishAttempt(ev.id, ["wss://two.example"], []);
    expect(await getQueuedPublishes()).toEqual([]);
  });

  it("carries pending old targets onto a newer explicit replaceable", async () => {
    const older = event({ kind: 30078, created_at: 100, tags: [["d", "armada/test"]] });
    const newer = event({ kind: 30078, created_at: 200, tags: [["d", "armada/test"]] });
    await queueSignedEvent(older, undefined, ["wss://old.example"]);
    await queueSignedEvent(newer, undefined, ["wss://new.example"]);

    const queued = await getQueuedPublishes();
    expect(queued).toHaveLength(1);
    expect(queued[0].event.id).toBe(newer.id);
    expect(queued[0].relays).toEqual(["wss://new.example", "wss://old.example"]);
  });

  it("keeps unanswered predecessor targets on their safe older edition", async () => {
    const older = event({ kind: 30078, created_at: 100, tags: [["d", "armada/partial"]] });
    const newer = event({ kind: 30078, created_at: 200, tags: [["d", "armada/partial"]] });
    await queueSignedEvent(
      older,
      undefined,
      ["wss://answered.example", "wss://unanswered.example"],
    );
    await queueSignedEvent(newer, undefined, ["wss://answered.example"], {
      inheritPendingTargets: false,
    });

    const queued = await getQueuedPublishes();
    expect(queued).toHaveLength(2);
    expect(queued.find((item) => item.id === newer.id)?.relays)
      .toEqual(["wss://answered.example"]);
    expect(queued.find((item) => item.id === older.id)?.relays)
      .toEqual(["wss://unanswered.example"]);
  });

  it("refuses to extend a newer queued winner to a disjoint opt-out cohort", async () => {
    const newer = event({ kind: 30078, created_at: 200, tags: [["d", "armada/conflict"]] });
    const older = event({ kind: 30078, created_at: 100, tags: [["d", "armada/conflict"]] });
    await queueSignedEvent(newer, undefined, ["wss://one.example"]);

    await expect(queueSignedEvent(older, undefined, ["wss://one.example"], {
      inheritPendingTargets: false,
    })).rejects.toThrow(/fresh source read/);
    await expect(queueSignedEvent(older, undefined, ["wss://two.example"], {
      inheritPendingTargets: false,
    })).rejects.toThrow(/fresh source read/);

    const queued = await getQueuedPublishes();
    expect(queued).toHaveLength(1);
    expect(queued[0].event.id).toBe(newer.id);
    expect(queued[0].relays).toEqual(["wss://one.example"]);
  });

  it("keeps the old replaceable obligation when its replacement cannot be written", async () => {
    const older = event({ kind: 30078, created_at: 100, tags: [["d", "armada/safe"]] });
    const newer = event({ kind: 30078, created_at: 200, tags: [["d", "armada/safe"]] });
    await queueSignedEvent(older, undefined, ["wss://old.example"]);

    const set = vi.spyOn(getArmadaDB().kv, "set").mockRejectedValueOnce(new Error("quota"));
    await expect(queueSignedEvent(newer, undefined, ["wss://new.example"]))
      .rejects.toThrow("quota");
    set.mockRestore();

    const queued = await getQueuedPublishes();
    expect(queued).toHaveLength(1);
    expect(queued[0].event.id).toBe(older.id);
    expect(queued[0].relays).toEqual(["wss://old.example"]);
  });

  it("rejects a silent no-op instead of claiming the event is durably queued", async () => {
    // Complete the migration before replacing `set`, so this isolates the
    // queue write itself (the degraded IndexedDB adapter has this exact shape).
    await getQueuedPublishes();
    const set = vi.spyOn(getArmadaDB().kv, "set").mockResolvedValue(undefined);
    await expect(queueSignedEvent(event({ created_at: 333 })))
      .rejects.toThrow(/could not be verified/);
    set.mockRestore();
  });

  it("serializes concurrent editions of one replaceable coordinate", async () => {
    const older = event({ kind: 30078, created_at: 100, tags: [["d", "armada/race"]] });
    const newer = event({ kind: 30078, created_at: 200, tags: [["d", "armada/race"]] });

    await Promise.all([
      queueSignedEvent(older, undefined, ["wss://old.example"]),
      queueSignedEvent(newer, undefined, ["wss://new.example"]),
    ]);

    const queued = await getQueuedPublishes();
    expect(queued).toHaveLength(1);
    expect(queued[0].event.id).toBe(newer.id);
    expect(queued[0].relays).toEqual(["wss://new.example", "wss://old.example"]);
  });

  it("does not erase a relay appended while another target was in flight", async () => {
    const ev = event();
    await queueSignedEvent(ev, undefined, ["wss://one.example"]);
    await queueSignedEvent(ev, undefined, ["wss://two.example"]);

    await recordQueuedPublishAttempt(ev.id, ["wss://one.example"], []);
    expect((await getQueuedPublishes())[0].relays).toEqual(["wss://two.example"]);
  });

  it("refuses an explicit publish queue with no destination", async () => {
    await expect(queueSignedEvent(event(), undefined, [])).rejects.toThrow(/without a relay destination/);
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

    it("returns a signed event untouched, and refuses an unknown one", async () => {
      const ev = event();
      expect(await withSignature(ev)).toBe(ev);

      // No signed copy anywhere: there is nothing a relay would accept, so the
      // caller is told rather than handed an event that is certain to bounce.
      const orphan = { ...event({ created_at: 9 }), sig: "" };
      await expect(withSignature(orphan)).rejects.toThrow(/signature was not kept/);
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

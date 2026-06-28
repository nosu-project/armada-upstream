import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPublishOutbox,
  getQueuedPublishes,
  markQueuedPublishFailure,
  queueSignedEvent,
  removeQueuedPublish,
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

describe("publish outbox", () => {
  beforeEach(() => {
    clearPublishOutbox();
  });

  it("queues signed events and removes them after publish", () => {
    const ev = event();
    queueSignedEvent(ev);
    expect(getQueuedPublishes().map((item) => item.id)).toEqual([ev.id]);

    removeQueuedPublish(ev.id);
    expect(getQueuedPublishes()).toEqual([]);
  });

  it("does not duplicate the same event id", () => {
    const ev = event();
    queueSignedEvent(ev);
    queueSignedEvent(ev);
    expect(getQueuedPublishes()).toHaveLength(1);
  });

  it("keeps only the newest queued replaceable profile event", () => {
    const older = event({ kind: 0, created_at: 100, content: JSON.stringify({ name: "old" }) });
    const newer = event({ kind: 0, created_at: 200, content: JSON.stringify({ name: "new" }) });

    queueSignedEvent(older);
    queueSignedEvent(newer);

    const queued = getQueuedPublishes();
    expect(queued).toHaveLength(1);
    expect(queued[0].event.content).toBe(newer.content);
  });

  it("does not replace a newer replaceable event with an older one", () => {
    const newer = event({ kind: 0, created_at: 200, content: JSON.stringify({ name: "new" }) });
    const older = event({ kind: 0, created_at: 100, content: JSON.stringify({ name: "old" }) });

    queueSignedEvent(newer);
    queueSignedEvent(older);

    const queued = getQueuedPublishes();
    expect(queued).toHaveLength(1);
    expect(queued[0].event.content).toBe(newer.content);
  });

  it("records retry state after a failed publish attempt", () => {
    const ev = event();
    queueSignedEvent(ev);
    markQueuedPublishFailure(ev.id, new Error("offline"));

    const [queued] = getQueuedPublishes();
    expect(queued.attempts).toBe(1);
    expect(queued.lastError).toBe("offline");
    expect(queued.nextAttemptAt).toBeGreaterThan(Date.now());
  });
});

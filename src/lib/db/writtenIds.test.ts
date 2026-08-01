/**
 * The write dedupe's correctness rules.
 *
 * Skipping a re-write is safe because an event id is a hash of the event — but
 * only if the skip can never claim something the store didn't do. Three rules
 * carry that, and each one is a way the optimization could silently lose data:
 *
 *  - an id is recorded only after the write COMMITS, because `resolved` means
 *    durable to callers, one of which destroys the only copy of a parked wrap on
 *    the strength of it;
 *  - a `remove()` forgets everything, because a removed event must be storable
 *    again and the removal is a filter this layer cannot evaluate;
 *  - the set is bounded, so a long-lived tab's memory is flat.
 */

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { IndexedDBArmadaDB } from "./IndexedDBArmadaDB";
import { WrittenIds } from "./writtenIds";

import type { NostrRumor } from "@/lib/nostrRumor";

function rumor(id: string, overrides: Partial<NostrRumor> = {}): NostrRumor {
  return {
    id: id.padEnd(64, "0"),
    kind: 1,
    content: "hello",
    created_at: 1000,
    pubkey: "a".repeat(64),
    tags: [],
    ...overrides,
  };
}

describe("WrittenIds", () => {
  it("forgets everything on demand, because a filter can't be replayed", () => {
    const ids = new WrittenIds();
    ids.add("a");
    ids.add("b");
    expect(ids.has("a")).toBe(true);

    ids.forget();

    expect(ids.has("a")).toBe(false);
    expect(ids.has("b")).toBe(false);
    expect(ids.size).toBe(0);
  });

  it("is bounded, evicting oldest first", () => {
    const ids = new WrittenIds();
    for (let i = 0; i < 20_050; i++) ids.add(`id-${i}`);

    expect(ids.size).toBeLessThanOrEqual(20_000);
    // The oldest went, the newest stayed.
    expect(ids.has("id-0")).toBe(false);
    expect(ids.has("id-20049")).toBe(true);
  });
});

describe("IndexedDBArmadaDB write dedupe", () => {
  let db: IndexedDBArmadaDB;

  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    db = new IndexedDBArmadaDB(`dedupe-${Math.random().toString(36).slice(2)}`);
  });

  it("stores an event once and reads it back after a re-write", async () => {
    const store = db.tenant("main");
    const event = rumor("aa");

    await store.event(event);
    // The second write is skipped — the row must still be there, exactly once.
    await store.event(event);
    await store.event(event);

    const rows = await store.query([{ ids: [event.id] }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("hello");
    expect((await store.count([{}])).count).toBe(1);
  });

  it("stores an event again after a remove() — the skip must not outlive the row", async () => {
    const store = db.tenant("main");
    const event = rumor("bb");

    await store.event(event);
    expect((await store.query([{ ids: [event.id] }]))).toHaveLength(1);

    // Removal is expressed as a filter, so the dedupe drops its whole set
    // rather than guessing which ids matched.
    await store.remove([{ ids: [event.id] }]);
    expect((await store.query([{ ids: [event.id] }]))).toHaveLength(0);

    await store.event(event);
    expect((await store.query([{ ids: [event.id] }]))).toHaveLength(1);
  });

  it("still supersedes a replaceable event, since a new version has a new id", async () => {
    const store = db.tenant("main");
    const older = rumor("cc", { kind: 0, created_at: 1000, content: '{"name":"old"}' });
    const newer = rumor("dd", { kind: 0, created_at: 2000, content: '{"name":"new"}' });

    await store.event(older);
    await store.event(older); // skipped
    await store.event(newer);

    const rows = await store.query([{ kinds: [0] }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('{"name":"new"}');
  });

  it("keeps tenants independent — one tenant's writes never mask another's", async () => {
    const event = rumor("ee");

    await db.tenant("main").event(event);
    // Same id, different tenant: this must NOT be skipped, or a relay-scoped
    // copy would go missing because a global one happened to be stored first.
    await db.tenant("nip29:wss://relay.example").event(event);

    expect((await db.tenant("main").query([{ ids: [event.id] }]))).toHaveLength(1);
    expect(
      await db.tenant("nip29:wss://relay.example").query([{ ids: [event.id] }]),
    ).toHaveLength(1);
  });
});

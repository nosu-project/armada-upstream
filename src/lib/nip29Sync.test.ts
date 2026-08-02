// @vitest-environment node
/**
 * The `nip29:` sync-topic handler: a round pulls a group's newest page from
 * ITS relay, mirrors the events into the relay-scoped tenant (awaited, so the
 * bus ring that follows never races the write), records page fullness for the
 * timeline's scroll-up affordance, and settles the topic — while a failed or
 * context-less round marks it error instead of stamping it fresh.
 */
import { IDBFactory } from "fake-indexeddb";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RELAY = "wss://groups.test";
const GROUP = "g1";

/** A fresh module graph: scheduler, stores, bus, and the handler. */
async function freshModules() {
  vi.resetModules();
  const manager = await import("@/sync/syncManager");
  const nip29Sync = await import("./nip29Sync");
  const bus = await import("@/wire/bus");
  const { appEventStore } = await import("./db/mainEventStore");
  return { ...manager, ...nip29Sync, ...bus, appEventStore };
}

const sk = generateSecretKey();
let clock = 1_700_000_000;
function groupMsg(group: string): NostrEvent {
  return finalizeEvent(
    { kind: 9, content: "hello", tags: [["h", group]], created_at: clock++ },
    sk,
  );
}

function makePool(events: NostrEvent[] | (() => Promise<NostrEvent[]>)) {
  const queries: unknown[] = [];
  const pool = {
    relay: (url: string) => ({
      query: async (filters: unknown[]) => {
        queries.push({ url, filters });
        return typeof events === "function" ? await events() : events;
      },
    }),
  };
  return { pool, queries };
}

describe("nip29Sync — the nip29: topic handler", () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it("a round mirrors the newest page into the relay-scoped store, rings the bus, and settles", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const events = [groupMsg(GROUP), groupMsg(GROUP)];
    const { pool, queries } = makePool(events);

    const scopes: string[] = [];
    m.onWireScopes((batch) => scopes.push(...batch));

    const topic = m.nip29SyncTopic(RELAY, GROUP);
    m.setNip29SyncContext(topic, { nostr: pool });
    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("settled"), { timeout: 15_000 });

    // The mirror is awaited before the ring, so by the time the bus announced
    // the group, the rows were readable from the relay's tenant.
    await vi.waitFor(() => expect(scopes).toContain(`nip29:${GROUP}`));
    const store = await m.appEventStore();
    const rows = await store.query([{ kinds: [9], "#h": [GROUP] }], { relay: RELAY });
    expect(rows.map((r) => r.id).sort()).toEqual(events.map((e) => e.id).sort());
    // ...and only from that relay's tenant — the same group id elsewhere is an
    // unrelated room.
    expect(await store.query([{ kinds: [9], "#h": [GROUP] }], { relay: "wss://other.test" })).toEqual([]);

    // A short page: the relay has no older history to scroll into.
    expect(m.nip29PullFull(topic)).toBe(false);
    expect(queries.length).toBe(1);
    release();
  });

  it("records a full newest page so the timeline keeps its scroll-up affordance", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const { pool } = makePool(Array.from({ length: m.NIP29_PAGE_SIZE }, () => groupMsg(GROUP)));
    const topic = m.nip29SyncTopic(RELAY, GROUP);
    m.setNip29SyncContext(topic, { nostr: pool });

    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("settled"), { timeout: 15_000 });
    expect(m.nip29PullFull(topic)).toBe(true);
    release();
  });

  it("a failed pull marks the topic error, never fresh", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const { pool } = makePool(() => Promise.reject(new Error("relay down")));
    const topic = m.nip29SyncTopic(RELAY, GROUP);
    m.setNip29SyncContext(topic, { nostr: pool });

    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("error"), { timeout: 15_000 });
    expect(m.syncState(topic).lastSyncedAt).toBeUndefined();
    expect(m.nip29PullFull(topic)).toBeUndefined();
    release();
  });

  it("a want without a registered context fails the run instead of stamping it fresh", { timeout: 30_000 }, async () => {
    const m = await freshModules();
    const topic = m.nip29SyncTopic(RELAY, GROUP);
    const release = m.want(topic);
    await vi.waitFor(() => expect(m.syncState(topic).status).toBe("error"), { timeout: 15_000 });
    expect(m.syncState(topic).lastSyncedAt).toBeUndefined();
    release();
  });
});

// @vitest-environment node
/**
 * The event-cache drain into the `main` tenant.
 *
 * This is the one migration whose data IS refetchable, so the bar is lower than
 * for the DM/invite/Concord drains — but a scan that silently stops early would
 * still leave an upgrading user staring at empty timelines until every relay
 * round-trip completes, and would delete the database it failed to read.
 */
import { NIndexedDB } from "@nostrify/indexeddb";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

const LEGACY = "armada-events";

function event(i: number, kind = 1): NostrEvent {
  return {
    id: String(i).padStart(64, "0"),
    kind,
    pubkey: "p".repeat(64),
    created_at: 1000 + i,
    content: `event-${i}`,
    tags: [["e", "target"]],
    sig: "s".repeat(128),
  };
}

/** Seed the legacy database, then drain it on a fresh module graph. */
async function drain(events: NostrEvent[]) {
  vi.resetModules();
  const legacy = new NIndexedDB(LEGACY);
  await Promise.all(events.map((ev) => legacy.event(ev)));
  await legacy.close();

  const mod = await import("./eventStoreMigration");
  await mod.migrateLegacyEvents();
  return mod;
}

describe("migrateLegacyEvents", () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it("copies the cache into the main tenant, dropping signatures", async () => {
    await drain([event(1), event(2, 0)]);

    const { appEventStore } = await import("./mainEventStore");
    const store = await appEventStore();

    const all = await store.query([{ limit: 100 }]);
    expect(all.map((e) => e.content).sort()).toEqual(["event-1", "event-2"]);
    // Rumors have no signature to carry; the field is reported empty, not real.
    expect(all.every((e) => e.sig === "")).toBe(true);

    // Tag and kind indexes are live in the tenant, not just the raw rows.
    expect((await store.query([{ "#e": ["target"] }])).length).toBe(2);
    expect((await store.query([{ kinds: [0] }])).map((e) => e.content)).toEqual(["event-2"]);
  });

  it("pages past the scan window instead of stopping at the first page", async () => {
    // More events than one page, so a drain that ignored `until` would copy
    // only the newest slice and then delete the rest with the database.
    const { PAGE_LIMIT } = await import("./eventStoreMigration");
    const total = PAGE_LIMIT + 250;
    await drain(Array.from({ length: total }, (_, i) => event(i)));

    const { appEventStore } = await import("./mainEventStore");
    expect((await (await appEventStore()).count([{ kinds: [1] }])).count).toBe(total);
  }, 30_000);

  it("is idempotent and flags itself done", async () => {
    const mod = await drain([event(1)]);
    await mod.migrateLegacyEvents();

    const { getArmadaDB } = await import("./armadaDB");
    expect(await getArmadaDB().kv.get("events:migrated")).toBe(true);

    const { appEventStore } = await import("./mainEventStore");
    expect((await (await appEventStore()).query([{ limit: 100 }])).length).toBe(1);
  });

  it("skips ephemeral kinds on write", async () => {
    vi.resetModules();
    const { appEventStore } = await import("./mainEventStore");
    const store = await appEventStore();
    await store.event(event(9, 20000));
    expect((await store.query([{ kinds: [20000] }])).length).toBe(0);
  });
});

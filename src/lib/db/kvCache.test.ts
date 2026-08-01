// @vitest-environment node
/**
 * The synchronous-view-over-async-KV cache, and the localStorage drain built
 * into it.
 *
 * Two things have to hold, and both are about the gap between construction and
 * the warm landing:
 *
 *  - a legacy value is never dropped before its KV copy is confirmed readable,
 *    since one of these holds unsent message drafts, and
 *  - a write made during that gap wins over what the warm reads, because the
 *    write is the newer fact.
 */
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

type KvCacheModule = typeof import("./kvCache");

/** A fresh module graph, so the KV singleton and the registry are new. */
async function freshModule(): Promise<KvCacheModule> {
  vi.resetModules();
  return await import("./kvCache");
}

describe("KvPrefixCache", () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it("reads back what it writes, and survives a reload", async () => {
    const { KvPrefixCache } = await freshModule();
    const cache = new KvPrefixCache<{ text: string }>({ prefix: "draft:" });
    await cache.ready();

    cache.set("room-a", { text: "hello" });
    expect(cache.get("room-a")).toEqual({ text: "hello" });

    // A second cache over the same prefix is what a reload looks like.
    const reloaded = new KvPrefixCache<{ text: string }>({ prefix: "draft:" });
    expect(reloaded.get("room-a")).toBeUndefined(); // not warmed yet
    await reloaded.ready();
    expect(reloaded.get("room-a")).toEqual({ text: "hello" });
  });




  it("lets a write during the warm win over what the warm reads", async () => {
    const { KvPrefixCache } = await freshModule();
    const seed = new KvPrefixCache<string>({ prefix: "draft:" });
    await seed.ready();
    seed.set("room", "on disk");
    // Give the fire-and-forget KV write a turn to land.
    await new Promise((r) => setTimeout(r, 0));

    const cache = new KvPrefixCache<string>({ prefix: "draft:" });
    const warming = cache.ready();
    cache.set("room", "typed just now");
    await warming;

    expect(cache.get("room")).toBe("typed just now");
  });

  it("notifies subscribers when the warm lands", async () => {
    const { KvPrefixCache } = await freshModule();
    const seed = new KvPrefixCache<string>({ prefix: "draft:" });
    await seed.ready();
    seed.set("room", "restored");
    await new Promise((r) => setTimeout(r, 0));

    const cache = new KvPrefixCache<string>({ prefix: "draft:" });
    const listener = vi.fn();
    cache.subscribe(listener);
    await cache.ready();

    expect(listener).toHaveBeenCalled();
    expect(cache.warmed).toBe(true);
  });


  it("drops everything on reset, so a logout can't leak into the next account", async () => {
    const { KvPrefixCache, resetKvCaches } = await freshModule();
    const cache = new KvPrefixCache<string>({ prefix: "draft:" });
    await cache.ready();
    cache.set("room", "private");

    resetKvCaches();

    expect(cache.get("room")).toBeUndefined();
    expect(cache.warmed).toBe(false);
  });
});

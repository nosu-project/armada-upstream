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

  it("drains localStorage into KV and removes the old keys", async () => {
    localStorage.setItem("chat-draft:relay|group", JSON.stringify({ content: "unsent" }));
    localStorage.setItem("chat-draft:other", JSON.stringify({ content: "also unsent" }));
    localStorage.setItem("unrelated:key", "left alone");

    const { KvPrefixCache } = await freshModule();
    const cache = new KvPrefixCache<{ content: string }>({
      prefix: "draft:",
      legacyPrefix: "chat-draft:",
    });
    await cache.ready();

    expect(cache.get("relay|group")).toEqual({ content: "unsent" });
    expect(cache.get("other")).toEqual({ content: "also unsent" });
    expect(localStorage.getItem("chat-draft:relay|group")).toBeNull();
    expect(localStorage.getItem("unrelated:key")).toBe("left alone");

    const { getArmadaDB } = await import("./armadaDB");
    expect(await getArmadaDB().kv.get("draft:relay|group")).toEqual({ content: "unsent" });
  });

  it("keeps the localStorage copy, and still serves it, when KV cannot store it", async () => {
    // KV degrades to a silent no-op where IndexedDB is unavailable (iOS
    // Lockdown Mode, some private-browsing contexts). Dropping the only other
    // copy on the strength of an unverified write loses the data outright —
    // and refusing to serve it for the session looks the same to the user.
    localStorage.setItem("chat-draft:room", JSON.stringify({ content: "unsent" }));
    const { KvPrefixCache } = await freshModule();
    const { getArmadaDB } = await import("./armadaDB");
    vi.spyOn(getArmadaDB().kv, "set").mockResolvedValue(undefined);

    const cache = new KvPrefixCache<{ content: string }>({
      prefix: "draft:",
      legacyPrefix: "chat-draft:",
    });
    await cache.ready();

    expect(localStorage.getItem("chat-draft:room")).not.toBeNull();
    expect(cache.get("room")).toEqual({ content: "unsent" });
  });

  it("tolerates a legacy value that was a bare string", async () => {
    // Older builds stored the draft text directly rather than a JSON object.
    localStorage.setItem("chat-draft:room", "just text");
    const { KvPrefixCache } = await freshModule();
    const cache = new KvPrefixCache<string>({ prefix: "draft:", legacyPrefix: "chat-draft:" });
    await cache.ready();
    expect(cache.get("room")).toBe("just text");
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

  it("drains under the id its own reads use", async () => {
    // The drain maps `legacyPrefix + id` to `prefix + id`, so a caller whose
    // id still carries the legacy prefix looks up `draft:chat-draft:room` and
    // silently finds nothing that was migrated. Every entry a real caller
    // stores must be reachable by the id that caller reads with.
    localStorage.setItem("chat-draft:wss://relay.example:group-1", JSON.stringify({ c: 1 }));

    const { KvPrefixCache } = await freshModule();
    const cache = new KvPrefixCache<{ c: number }>({
      prefix: "draft:",
      legacyPrefix: "chat-draft:",
    });
    await cache.ready();

    // Exactly how ChatComposer builds its id: no `chat-draft:` on the front.
    expect(cache.get("wss://relay.example:group-1")).toEqual({ c: 1 });
    expect(cache.ids()).toEqual(["wss://relay.example:group-1"]);
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

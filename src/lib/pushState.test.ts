import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deletePushState, pushStateKeys, readPushState, trimPushState, writePushState } from "@/lib/pushState";

afterEach(() => vi.unstubAllGlobals());

/** An older build's Cache Storage, keyed by absolute URL as it wrote them. */
function legacyCaches(entries: Record<string, string | Uint8Array<ArrayBuffer>>, origin = "https://armada.buzz") {
  const store = new Map(
    Object.entries(entries).map(([path, body]) => [`${origin}/.armada-push-state/${path}`, body]),
  );
  const cache = {
    keys: vi.fn(async () => [...store.keys()].map((url) => new Request(url))),
    match: vi.fn(async (request: Request) => {
      const body = store.get(request.url);
      return body === undefined ? undefined : new Response(body);
    }),
  };
  const caches = {
    has: vi.fn(async (name: string) => name === "armada-push-state-v1" && store.size > 0),
    open: vi.fn(async () => cache),
    delete: vi.fn(async () => {
      store.clear();
      return true;
    }),
  };
  vi.stubGlobal("caches", caches);
  return caches;
}

describe("push state", () => {
  it("reads back, deletes, and trims oldest-written first", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    await writePushState("seen/a", { outcome: "worker" });
    await writePushState("seen/b", { outcome: "worker" });
    await writePushState("seen/c", { outcome: "worker" });
    await writePushState("seen/a", { outcome: "suppressed" });
    await writePushState("badge", 3);

    expect(await readPushState("seen/a")).toEqual({ outcome: "suppressed" });
    expect(await pushStateKeys("seen/")).toEqual(["seen/b", "seen/c", "seen/a"]);

    await trimPushState("seen/", 2);
    expect(await pushStateKeys("seen/")).toEqual(["seen/c", "seen/a"]);

    await deletePushState("badge");
    expect(await readPushState("badge")).toBeUndefined();
  });

  it("moves an older build's Cache Storage entries over once, then deletes the cache", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const sealed = new Uint8Array([1, 2, 3, 4]);
    const caches = legacyCaches({
      "dm-config": sealed,
      disabled: "1",
      "own/ev%2F1": "1",
      "seen/legacy": "1",
      "seen/new": JSON.stringify({ outcome: "page-presented", roomKey: "r" }),
      "alert/room": JSON.stringify([1, 2]),
      badge: "7",
    }, "nsite://abc");

    expect(await readPushState("dm-config")).toEqual(sealed);
    expect(await readPushState("disabled")).toBe(true);
    expect(await readPushState("own/ev%2F1")).toBe(true);
    expect(await readPushState("seen/legacy")).toEqual({ outcome: "handled" });
    expect(await readPushState("seen/new")).toEqual({ outcome: "page-presented", roomKey: "r" });
    expect(await readPushState("alert/room")).toEqual([1, 2]);
    expect(await readPushState("badge")).toBe(7);
    expect(caches.delete).toHaveBeenCalledWith("armada-push-state-v1");
  });

  it("never overwrites what a newer context already wrote, and runs once", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    // A newer page lifted the kill switch and wrote a config before this
    // context first opened the store.
    const raw = await openDB("armada-push-state", 1, {
      upgrade(db) {
        db.createObjectStore("state");
      },
    });
    await raw.put("state", { value: new Uint8Array([9]), at: 1, n: 1 }, "dm-config");
    raw.close();
    legacyCaches({ "dm-config": new Uint8Array([1]), "seen/x": "1" });

    expect(await readPushState("dm-config")).toEqual(new Uint8Array([9]));
    expect(await readPushState("seen/x")).toEqual({ outcome: "handled" });

    await deletePushState("seen/x");
    // Reopen on the same factory, as the next worker start would.
    vi.stubGlobal("indexedDB", new IDBFactory());
    await readPushState("seen/x");
    vi.stubGlobal("indexedDB", factory);
    legacyCaches({ "seen/x": "1" });
    expect(await readPushState("seen/x")).toBeUndefined();
  });
});

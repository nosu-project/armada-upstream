import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pushStateKeys, readPushState } from "@/lib/pushState";
import { markOwnWebPushEvent } from "@/lib/webPushState";

describe("Web Push local-event state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores an event marker under the key read by the service worker", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());

    await markOwnWebPushEvent("event/id");

    expect(await readPushState("own/event%2Fid")).toBe(true);
  });

  it("keeps only the newest markers", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());

    for (let i = 0; i < 515; i++) await markOwnWebPushEvent(`e${i}`);

    const keys = await pushStateKeys("own/");
    expect(keys).toHaveLength(512);
    expect(keys[0]).toBe("own/e3");
    expect(keys.at(-1)).toBe("own/e514");
  });
});

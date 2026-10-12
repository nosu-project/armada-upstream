// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { bytesToHex, channelGroupKey, exportGroupKeyMemo } from "@/concord/lib/derive";
import { clearGroupKeyMemory, initGroupKeyPersistence } from "@/concord/lib/groupKeyPersist";
import { getArmadaDB } from "@/lib/db/armadaDB";

const SECRET = new Uint8Array(32).fill(7);
const KV_KEY = "c2gkmemo";

const stored = () => getArmadaDB().kv.get<Array<{ sk: string }>>(KV_KEY);
const settle = () => new Promise((r) => setTimeout(r, 50));

afterEach(() => vi.useRealTimers());

// Ordered: clearGroupKeyMemory latches for the module's life, as it does for a page's.
describe("groupKey persistence across logout", () => {
  it("persists on pagehide while live", async () => {
    await initGroupKeyPersistence();
    const key = channelGroupKey(SECRET, new Uint8Array(32).fill(1), 0);
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect((await stored())?.map((e) => e.sk)).toContain(bytesToHex(key.sk));
  });

  it("never writes back after clearGroupKeyMemory, by pagehide or debounce", async () => {
    await getArmadaDB().kv.delete(KV_KEY);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    channelGroupKey(SECRET, new Uint8Array(32).fill(2), 0); // arms the debounce

    clearGroupKeyMemory();
    expect(exportGroupKeyMemo(4096)).toEqual([]);

    channelGroupKey(SECRET, new Uint8Array(32).fill(3), 0); // a derivation after logout began
    window.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
    await settle();

    expect(await stored()).toBeFalsy();
  });
});

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { IdLog } from "./idLog";

function memoryKv() {
  const rows = new Map<string, string>();
  const writes: string[] = [];
  return {
    rows,
    writes,
    kv: {
      set: async (key: string, value: string) => {
        writes.push(key);
        rows.set(key, value);
      },
      delete: async (key: string) => void rows.delete(key),
      list: async <T,>({ prefix }: { prefix: string }) =>
        [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: value as T })),
    },
  };
}

const id = (n: number) => n.toString(16).padStart(8, "0");
const opts = { prefix: "t:", idChars: 8, chunkIds: 4, keepChunks: 3, flushMs: 100 };

afterEach(() => vi.useRealTimers());

describe("IdLog", () => {
  it("rewrites only the open chunk, ages whole chunks out, and reloads in order", async () => {
    vi.useFakeTimers();
    const store = memoryKv();
    const log = new IdLog(() => store.kv, opts);
    await log.load();
    for (let n = 0; n < 14; n++) log.add(id(n));
    await vi.advanceTimersByTimeAsync(200);

    // Three full chunks were written as they filled (the first then aged out),
    // plus the open one: never one value holding everything.
    expect([...store.rows.keys()].sort()).toEqual(["t:0000000001", "t:0000000002", "t:0000000003"]);
    expect(store.rows.get("t:0000000003")).toBe(id(12) + id(13));

    const next = new IdLog(() => store.kv, opts);
    expect(await next.load()).toEqual(Array.from({ length: 10 }, (_, i) => id(i + 4)));
    // A new session starts its own chunk rather than rewriting the last one.
    next.add(id(99));
    await vi.advanceTimersByTimeAsync(200);
    expect(store.rows.get("t:0000000004")).toBe(id(99));
    expect(store.rows.get("t:0000000003")).toBe(id(12) + id(13));
  });

  it("holds adds made before the load until it knows where to write", async () => {
    vi.useFakeTimers();
    const store = memoryKv();
    store.rows.set("t:0000000007", id(1));
    const log = new IdLog(() => store.kv, opts);
    log.add(id(2));
    await vi.advanceTimersByTimeAsync(200);
    expect(store.writes).toEqual([]);
    await log.load();
    expect(store.rows.get("t:0000000008")).toBe(id(2));
  });
});

// @vitest-environment jsdom
/**
 * The hook side of the scheduler: mounting declares the want, unmounting
 * releases it (aborting an in-flight run), and state flows reactively.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SyncCtx } from "./syncManager";

/** A fresh module graph, so the scheduler and the KV singleton are new. */
async function freshModules() {
  vi.resetModules();
  const manager = await import("./syncManager");
  const { useSyncTopic } = await import("./useSyncTopic");
  return { ...manager, useSyncTopic };
}

describe("useSyncTopic", () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it("declares the want on mount and reports the settled state", async () => {
    const m = await freshModules();
    const handler = vi.fn(async () => {});
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const { result, unmount } = renderHook(() => m.useSyncTopic("t:a"));
    await waitFor(() => expect(result.current.status).toBe("settled"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.current.lastSyncedAt).toBeTypeOf("number");
    unmount();
  });

  it("releases the want on unmount, aborting an in-flight run", async () => {
    const m = await freshModules();
    let signal: AbortSignal | undefined;
    const handler = vi.fn(
      (ctx: SyncCtx) =>
        new Promise<void>((_, reject) => {
          signal = ctx.signal;
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const { unmount } = renderHook(() => m.useSyncTopic("t:a"));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    unmount();

    expect(signal?.aborted).toBe(true);
  });

  it("an undefined topic wants nothing and reads idle", async () => {
    const m = await freshModules();
    const handler = vi.fn(async () => {});
    m.registerSyncTopic("t:", { minIntervalMs: 0, staleAfterMs: 60_000, handler });

    const { result, unmount } = renderHook(() => m.useSyncTopic(undefined));
    await new Promise((r) => setTimeout(r, 20));

    expect(result.current.status).toBe("idle");
    expect(handler).not.toHaveBeenCalled();
    unmount();
  });
});

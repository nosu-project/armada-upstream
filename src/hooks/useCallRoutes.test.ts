// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CallRoutesSnapshot } from "@/lib/callRoutes";

import { useCallRoutes } from "./useCallRoutes";

const native = vi.hoisted(() => ({
  available: true,
  snapshot: { supported: true, routes: [], active: null } as CallRoutesSnapshot,
  listener: null as ((s: CallRoutesSnapshot) => void) | null,
  removed: 0,
  listRoutes: vi.fn(async () => native.snapshot),
  selectRoute: vi.fn<(o: { id: number }) => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
}));

vi.mock("@/lib/nativeCall", () => ({
  hasNativeCallService: () => native.available,
  ArmadaCall: {
    listRoutes: () => native.listRoutes(),
    selectRoute: (o: { id: number }) => native.selectRoute(o),
    addListener: async (_name: string, fn: (s: CallRoutesSnapshot) => void) => {
      native.listener = fn;
      return { remove: () => { native.removed += 1; } };
    },
  },
}));

const speaker = { id: 3, type: "speaker" as const, name: "" };
const earpiece = { id: 2, type: "earpiece" as const, name: "" };

describe("useCallRoutes", () => {
  afterEach(() => {
    native.available = true;
    native.listener = null;
    native.removed = 0;
    native.snapshot = { supported: true, routes: [], active: null };
    native.listRoutes.mockClear();
    native.selectRoute.mockClear();
  });

  it("loads the routes, follows change events, and unsubscribes on unmount", async () => {
    native.snapshot = { supported: true, routes: [speaker, earpiece], active: 3 };
    const { result, unmount } = renderHook(() => useCallRoutes());
    await waitFor(() => expect(result.current.routes).toHaveLength(2));
    expect(result.current.active).toBe(3);

    act(() => native.listener?.({ supported: true, routes: [speaker, earpiece], active: 2 }));
    expect(result.current.active).toBe(2);

    unmount();
    expect(native.removed).toBe(1);
  });

  it("selects a route and re-reads the snapshot on success", async () => {
    native.snapshot = { supported: true, routes: [speaker, earpiece], active: 3 };
    const { result } = renderHook(() => useCallRoutes());
    await waitFor(() => expect(result.current.routes).toHaveLength(2));

    native.snapshot = { supported: true, routes: [speaker, earpiece], active: 2 };
    let ok = false;
    await act(async () => {
      ok = await result.current.select(2);
    });
    expect(ok).toBe(true);
    expect(native.selectRoute).toHaveBeenCalledWith({ id: 2 });
    expect(result.current.active).toBe(2);
  });

  it("reports a refused switch without changing the snapshot", async () => {
    native.snapshot = { supported: true, routes: [speaker], active: 3 };
    native.selectRoute.mockResolvedValueOnce({ ok: false });
    const { result } = renderHook(() => useCallRoutes());
    await waitFor(() => expect(result.current.routes).toHaveLength(1));
    let ok = true;
    await act(async () => {
      ok = await result.current.select(2);
    });
    expect(ok).toBe(false);
    expect(native.listRoutes).toHaveBeenCalledTimes(1);
  });

  it("stays unsupported without the native service", async () => {
    native.available = false;
    const { result } = renderHook(() => useCallRoutes());
    await Promise.resolve();
    expect(result.current.supported).toBe(false);
    expect(native.listRoutes).not.toHaveBeenCalled();
  });
});

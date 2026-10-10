// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useMeshTransportState } from "./useMeshTransport";

const h = vi.hoisted(() => ({
  resolvers: [] as Array<() => void>,
  removed: [] as string[],
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { meshEnabled: false, meshIncognito: false }, updateConfig: vi.fn() }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUserProfile: () => ({ user: undefined, metadata: undefined }),
}));
vi.mock("@/lib/bluetoothMesh", () => ({
  BluetoothMesh: {
    isAvailable: async () => ({ available: true }),
    // Resolves only when the test says so, to land after cleanup.
    addListener: (name: string) =>
      new Promise<{ remove: () => Promise<void> }>((resolve) => {
        h.resolvers.push(() => resolve({ remove: async () => { h.removed.push(name); } }));
      }),
  },
}));

describe("useMeshTransportState listener registration", () => {
  it("removes a listener handle that resolves after unmount", async () => {
    const view = renderHook(() => useMeshTransportState());
    await act(async () => {});
    expect(h.resolvers).toHaveLength(1);
    view.unmount();

    await act(async () => { h.resolvers[0](); });
    expect(h.removed).toEqual(["message"]);
    // Cancelled before the second registration, so it is never made.
    expect(h.resolvers).toHaveLength(1);
  });
});

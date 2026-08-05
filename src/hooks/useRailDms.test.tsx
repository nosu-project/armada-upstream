import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultConfig, type AppConfig } from "@/contexts/AppContext";

import { useRailDms } from "./useRailDms";

const PEER = "a".repeat(64);
const OTHER = "b".repeat(64);
const RELAY_A = "wss://a.example/";
const RELAY_B = "wss://b.example/";

let config: AppConfig;
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config,
    updateConfig: (updater: (c: AppConfig) => AppConfig) => {
      config = updater(config);
    },
  }),
}));

/** Render the hook, re-rendering it after each config write. */
function railDms() {
  const { result, rerender } = renderHook(() => useRailDms());
  return {
    get current() {
      return result.current;
    },
    act(fn: (hook: ReturnType<typeof useRailDms>) => void) {
      act(() => fn(result.current));
      rerender();
    },
  };
}

describe("useRailDms", () => {
  beforeEach(() => {
    config = { ...defaultConfig, railLayout: [], railOrder: [], railOpenFolders: [] };
  });

  it("adds a DM to the end of the rail, in both the layout and the flat order", () => {
    config.railLayout = [{ type: "item", key: RELAY_A }];
    const hook = railDms();
    hook.act((h) => h.addToRail(PEER));

    expect(config.railLayout).toEqual([
      { type: "item", key: RELAY_A },
      { type: "item", key: `dm:${PEER}` },
    ]);
    expect(config.railOrder).toEqual([RELAY_A, `dm:${PEER}`]);
    expect(hook.current.railDms).toEqual([PEER]);
    expect(hook.current.isOnRail(PEER)).toBe(true);
    expect(hook.current.isOnRail(OTHER)).toBe(false);
  });

  it("seeds from the legacy flat order rather than replacing the arrangement", () => {
    // A client that only ever wrote `railOrder` (no structured layout yet).
    // Writing a layout of just the new DM would leave every server to be
    // re-appended in discovery order — silently reordering the user's rail.
    config.railOrder = [RELAY_B, RELAY_A];
    const hook = railDms();
    hook.act((h) => h.addToRail(PEER));

    expect(config.railOrder).toEqual([RELAY_B, RELAY_A, `dm:${PEER}`]);
    expect(config.railLayout).toEqual([
      { type: "item", key: RELAY_B },
      { type: "item", key: RELAY_A },
      { type: "item", key: `dm:${PEER}` },
    ]);
  });

  it("is idempotent — adding twice doesn't duplicate the icon", () => {
    const hook = railDms();
    hook.act((h) => h.addToRail(PEER));
    const after = config;
    hook.act((h) => h.addToRail(PEER));

    expect(config).toBe(after); // same object: no config churn, no NIP-78 publish
    expect(hook.current.railDms).toEqual([PEER]);
  });

  it("removes a DM from wherever it sits, including inside a folder", () => {
    config.railLayout = [
      { type: "folder", id: "f", name: "", keys: [RELAY_A, `dm:${PEER}`, RELAY_B] },
    ];
    config.railOrder = [RELAY_A, `dm:${PEER}`, RELAY_B];
    const hook = railDms();
    hook.act((h) => h.removeFromRail(PEER));

    expect(config.railLayout).toEqual([
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B] },
    ]);
    expect(config.railOrder).toEqual([RELAY_A, RELAY_B]);
    expect(hook.current.railDms).toEqual([]);
  });

  it("toggles both ways", () => {
    const hook = railDms();
    hook.act((h) => h.toggleRail(PEER));
    expect(hook.current.isOnRail(PEER)).toBe(true);
    hook.act((h) => h.toggleRail(PEER));
    expect(hook.current.isOnRail(PEER)).toBe(false);
  });

  it("reports peers in the rail's visual order, folders flattened in place", () => {
    config.railLayout = [
      { type: "folder", id: "f", name: "", keys: [RELAY_A, `dm:${OTHER}`] },
      { type: "item", key: `dm:${PEER}` },
    ];
    expect(railDms().current.railDms).toEqual([OTHER, PEER]);
  });
});

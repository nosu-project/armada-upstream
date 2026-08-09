import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultConfig, type AppConfig } from "@/contexts/AppContext";
import { flattenLayout, mergeLayout } from "@/lib/railLayout";

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
    config = { ...defaultConfig, railLayout: [], railOpenFolders: [] };
  });

  // The top, not the end: the stored arrangement holds only what the user has
  // arranged, and the rail's `mergeLayout` appends every live server and
  // community it doesn't know AFTER it — so an appended DM would render in the
  // middle. Only the top means the same place before and after that append.
  it("adds a DM to the top of the rail", () => {
    config.railLayout = [{ type: "item", key: RELAY_A }];
    const hook = railDms();
    hook.act((h) => h.addToRail(PEER));

    expect(config.railLayout).toEqual([
      { type: "item", key: `dm:${PEER}` },
      { type: "item", key: RELAY_A },
    ]);
    expect(hook.current.railDms).toEqual([PEER]);
    expect(hook.current.isOnRail(PEER)).toBe(true);
    expect(hook.current.isOnRail(OTHER)).toBe(false);
  });

  // The regression the top placement exists for: a rail whose stored layout is
  // behind the live lists (nothing dragged yet, or a community joined since).
  it("lands above communities the stored arrangement doesn't mention yet", () => {
    config.railLayout = [{ type: "item", key: RELAY_A }];
    const hook = railDms();
    hook.act((h) => h.addToRail(PEER));

    // RELAY_B is live but unarranged, so the rail appends it after the stored
    // keys. The DM must still be first — not wedged between the two.
    expect(
      flattenLayout(mergeLayout(config.railLayout, [RELAY_A, RELAY_B])),
    ).toEqual([`dm:${PEER}`, RELAY_A, RELAY_B]);
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
    const hook = railDms();
    hook.act((h) => h.removeFromRail(PEER));

    expect(config.railLayout).toEqual([
      { type: "folder", id: "f", name: "", keys: [RELAY_A, RELAY_B] },
    ]);
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

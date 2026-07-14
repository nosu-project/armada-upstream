/**
 * Notification-level cascade + legacy-mute migration.
 *
 * Verifies the Discord-style resolution: a channel inherits its community's
 * level, a community inherits the account-global per-type prefs, an explicit
 * level overrides, and pre-existing `mutedChannels`/`mutedCommunities` entries
 * read as level `nothing` without a migration step.
 */

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotifLevels } from "./useNotifLevels";

import type { AppConfig } from "@/contexts/AppContext";

const RELAY = "wss://relay.example";
const GROUP = "grp1";

const h = vi.hoisted(() => ({
  config: {} as AppConfig,
  updateConfig: (u: (c: AppConfig) => AppConfig) => {
    h.config = u(h.config);
  },
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config, updateConfig: h.updateConfig }),
}));

// normalizeRelayUrl is used by the scope-key helpers; keep it identity-ish.
vi.mock("@/lib/platform", () => ({
  normalizeRelayUrl: (u: string) => u.replace(/\/+$/, ""),
}));

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    notifLevels: {},
    mutedCommunities: [],
    mutedChannels: [],
    ...over,
  } as AppConfig;
}

beforeEach(() => {
  h.config = baseConfig();
  localStorage.clear();
  // Global default: all channel messages on, DMs on.
  localStorage.setItem(
    "armada:push-prefs",
    JSON.stringify({
      mentions: true,
      reactions: true,
      replies: true,
      directMessages: true,
      allGroupMessages: true,
    }),
  );
});

afterEach(() => localStorage.clear());

describe("useNotifLevels cascade", () => {
  it("falls back to the global level (all) when nothing is set", () => {
    const { result } = renderHook(() => useNotifLevels());
    expect(result.current.channelLevel(RELAY, GROUP)).toBe("all");
  });

  it("falls back to global 'mentions' when allGroupMessages is off", () => {
    localStorage.setItem(
      "armada:push-prefs",
      JSON.stringify({ mentions: true, allGroupMessages: false, directMessages: true }),
    );
    const { result } = renderHook(() => useNotifLevels());
    expect(result.current.channelLevel(RELAY, GROUP)).toBe("mentions");
  });

  it("inherits the community level when the channel has none", () => {
    h.config = baseConfig({ notifLevels: { [RELAY]: "mentions" } });
    const { result } = renderHook(() => useNotifLevels());
    expect(result.current.channelLevel(RELAY, GROUP)).toBe("mentions");
  });

  it("an explicit channel level overrides the community level", () => {
    h.config = baseConfig({
      notifLevels: { [RELAY]: "nothing", [`${RELAY}::${GROUP}`]: "all" },
    });
    const { result } = renderHook(() => useNotifLevels());
    expect(result.current.channelLevel(RELAY, GROUP)).toBe("all");
  });

  it("reads a legacy muted channel as level 'nothing'", () => {
    h.config = baseConfig({ mutedChannels: [`${RELAY}::${GROUP}`] });
    const { result } = renderHook(() => useNotifLevels());
    expect(result.current.channelLevel(RELAY, GROUP)).toBe("nothing");
    expect(result.current.getLevel(`${RELAY}::${GROUP}`)).toBe("nothing");
  });

  it("reads a legacy muted community as level 'nothing' (cascades to channels)", () => {
    h.config = baseConfig({ mutedCommunities: [RELAY] });
    const { result } = renderHook(() => useNotifLevels());
    expect(result.current.communityLevel(RELAY)).toBe("nothing");
    expect(result.current.channelLevel(RELAY, GROUP)).toBe("nothing");
  });

  it("dmLevel follows the directMessages global by default", () => {
    const { result } = renderHook(() => useNotifLevels());
    expect(result.current.dmLevel("a".repeat(64))).toBe("all");
    localStorage.setItem("armada:push-prefs", JSON.stringify({ directMessages: false }));
    const { result: r2 } = renderHook(() => useNotifLevels());
    expect(r2.current.dmLevel("a".repeat(64))).toBe("nothing");
  });
});

describe("useNotifLevels setLevel", () => {
  it("writes an explicit level and mirrors 'nothing' into the mute set", () => {
    const { result } = renderHook(() => useNotifLevels());
    act(() => result.current.setLevel(`${RELAY}::${GROUP}`, "nothing"));
    expect(h.config.notifLevels[`${RELAY}::${GROUP}`]).toBe("nothing");
    expect(h.config.mutedChannels).toContain(`${RELAY}::${GROUP}`);
  });

  it("clearing a level drops it from both the level map and the mute set", () => {
    h.config = baseConfig({
      notifLevels: { [`${RELAY}::${GROUP}`]: "nothing" },
      mutedChannels: [`${RELAY}::${GROUP}`],
    });
    const { result } = renderHook(() => useNotifLevels());
    act(() => result.current.setLevel(`${RELAY}::${GROUP}`, "all"));
    expect(h.config.notifLevels[`${RELAY}::${GROUP}`]).toBe("all");
    expect(h.config.mutedChannels).not.toContain(`${RELAY}::${GROUP}`);
  });

  it("a DM level never touches the channel/community mute sets", () => {
    const { result } = renderHook(() => useNotifLevels());
    act(() => result.current.setLevel("dm:abc", "nothing"));
    expect(h.config.notifLevels["dm:abc"]).toBe("nothing");
    expect(h.config.mutedChannels).toHaveLength(0);
    expect(h.config.mutedCommunities).toHaveLength(0);
  });
});

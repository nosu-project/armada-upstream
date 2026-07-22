/**
 * Regression tests for the kind-10050 auto-publish bug.
 *
 * useEnsureDmInbox (now useAdoptDmInbox) used to publish a "first" DM relay
 * list whenever its read found none — but an empty read is indistinguishable
 * from a failed one (cold pool, wrong relay set, timeout), and 10050 is a
 * replaceable event, so that publish REPLACED the user's real inbox list
 * everywhere. The hook must never publish; it may only adopt an observed
 * published list into local config. See AGENTS.md "Never publish a user's
 * Nostr lists without an explicit user action."
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAdoptDmInbox } from "@/hooks/useDm17";
import { APP_RELAYS } from "@/lib/platform";

import type { AppConfig } from "@/contexts/AppContext";

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  config: {} as AppConfig,
  updateConfig: vi.fn((updater: (c: AppConfig) => AppConfig) => {
    h.config = updater(h.config);
  }),
  publish: vi.fn(),
  dmRelayList: {
    relays: [] as string[],
    isLoading: false,
    hasList: false,
    refetch: () => undefined,
    publish: undefined as unknown,
  },
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config, updateConfig: h.updateConfig }),
}));
vi.mock("@/hooks/useDmRelayList", () => ({
  useDmRelayList: () => ({ ...h.dmRelayList, publish: h.publish }),
  useDmRelaysFor: () => [],
}));
// Heavy siblings of useAdoptDmInbox in the same module; not under test.
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => new Promise(() => undefined),
}));
vi.mock("@/wire/useWireScopes", () => ({
  useWireScopes: () => ({}),
}));

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    useOwnDmRelays: false,
    dmRelays: [...APP_RELAYS],
    appRelays: [...APP_RELAYS],
    ...over,
  } as AppConfig;
}

beforeEach(() => {
  h.updateConfig.mockClear();
  h.publish.mockClear();
  h.config = baseConfig();
  h.dmRelayList = { relays: [], isLoading: false, hasList: false, refetch: () => undefined, publish: undefined };
});

describe("useAdoptDmInbox (kind 10050)", () => {
  it("NEVER publishes a DM relay list when the read finds none (the overwrite bug)", () => {
    // Pre-fix behavior: an empty/failed 10050 read triggered publish() with the
    // default relays, replacing any real list the read simply couldn't see.
    h.user = { pubkey: "1".repeat(64), signer: { nip44: {} } };
    renderHook(() => useAdoptDmInbox());
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it("adopts a published list into LOCAL config only — still no publish", () => {
    h.user = { pubkey: "2".repeat(64), signer: { nip44: {} } };
    h.dmRelayList = {
      relays: ["wss://inbox.example/"],
      isLoading: false,
      hasList: true,
      refetch: () => undefined,
      publish: undefined,
    };
    renderHook(() => useAdoptDmInbox());
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.config.useOwnDmRelays).toBe(true);
    expect(h.config.dmRelays).toEqual(["wss://inbox.example/"]);
  });

  it("leaves a deliberately customized local DM relay set alone", () => {
    h.user = { pubkey: "3".repeat(64), signer: { nip44: {} } };
    h.config = baseConfig({ dmRelays: ["wss://custom.example/"] });
    h.dmRelayList = {
      relays: ["wss://inbox.example/"],
      isLoading: false,
      hasList: true,
      refetch: () => undefined,
      publish: undefined,
    };
    renderHook(() => useAdoptDmInbox());
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });
});

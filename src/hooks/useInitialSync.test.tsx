import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInitialSync } from "@/hooks/useInitialSync";

const PUBKEY = "a".repeat(64);
const RELAY = "wss://relay.example.com";

const h = vi.hoisted(() => ({
  config: {
    appRelays: [] as string[],
    useAppRelays: true,
    useUserRelays: false,
    relayMetadata: { relays: [] as Array<{ url: string; read: boolean; write: boolean }>, updatedAt: 0 },
  },
  updateConfig: vi.fn(),
  discoverRelayList: vi.fn(),
  queryExplicitRelays: vi.fn(),
  resolveDmQuery: undefined as ((events: never[]) => void) | undefined,
  nostr: {},
  queryClient: {
    setQueryData: vi.fn(),
  },
  user: {
    pubkey: "a".repeat(64),
    signer: {},
  },
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: h.nostr }),
}));

vi.mock("@nostrify/react/login", () => ({
  useNostrLogin: () => ({ logins: [{ pubkey: h.user.pubkey }] }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => h.queryClient,
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config, updateConfig: h.updateConfig }),
}));

vi.mock("@/hooks/useDmRelayList", () => ({
  KIND_DM_RELAYS: 10050,
  parseDmRelays: () => [],
}));

vi.mock("@/lib/nip65", () => ({
  discoverRelayList: (...args: unknown[]) => h.discoverRelayList(...args),
  queryExplicitRelays: (...args: unknown[]) => h.queryExplicitRelays(...args),
  uniqueRelayUrls: (urls: Iterable<string>) => [...new Set(urls)],
}));

vi.mock("@/concord-v1/lib/concord", () => ({
  CONCORD_ENABLED: false,
  CONCORD_LIST_D_TAG: "armada/concord",
  CONCORD_LIST_KIND: 30078,
}));

describe("useInitialSync", () => {
  beforeEach(() => {
    h.config = {
      appRelays: [],
      useAppRelays: true,
      useUserRelays: false,
      relayMetadata: { relays: [], updatedAt: 0 },
    };
    h.updateConfig = vi.fn((updater: (current: typeof h.config) => typeof h.config) => {
      h.config = updater(h.config);
    });
    h.discoverRelayList.mockReset().mockResolvedValue({
      event: { created_at: 10 },
      relays: [{ url: RELAY, read: true, write: true }],
    });
    h.queryExplicitRelays.mockReset();
    h.queryExplicitRelays
      .mockImplementationOnce(
        () => new Promise<never[]>((resolve) => {
          h.resolveDmQuery = resolve;
        }),
      )
      .mockResolvedValue([]);
    h.resolveDmQuery = undefined;
    h.queryClient.setQueryData.mockClear();
  });

  it("continues after relay adoption recreates the config updater", async () => {
    const view = renderHook(() => useInitialSync(PUBKEY));

    await waitFor(() => expect(h.updateConfig).toHaveBeenCalledOnce());
    expect(view.result.current.log.find((line) => line.id === "relays")?.status).toBe("1 FOUND");

    h.updateConfig = vi.fn((updater: (current: typeof h.config) => typeof h.config) => {
      h.config = updater(h.config);
    });
    view.rerender();

    await act(async () => {
      h.resolveDmQuery?.([]);
    });

    await waitFor(() => expect(view.result.current.done).toBe(true));
    expect(view.result.current.log.at(-1)).toMatchObject({
      id: "ready",
      status: "READY",
    });
  });
});

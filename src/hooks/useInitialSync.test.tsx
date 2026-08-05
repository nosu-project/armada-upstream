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
    searchRelays: [] as string[],
    dmRelays: [] as string[],
    blossomServerMetadata: { servers: [] as string[], updatedAt: 0 },
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
  parseDmRelays: (event: { tags: string[][] } | undefined) =>
    event?.tags.filter(([name]) => name === "relay").map(([, url]) => url) ?? [],
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
      searchRelays: [],
      dmRelays: [],
      blossomServerMetadata: { servers: [], updatedAt: 0 },
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

  it("hydrates search, DM, and media fields from their canonical lists", async () => {
    const base = {
      pubkey: PUBKEY,
      content: "",
      sig: "s",
      created_at: 20,
    };
    h.queryExplicitRelays.mockReset()
      .mockResolvedValueOnce([
        { ...base, id: "search", kind: 10007, tags: [["relay", "wss://search.example"]] },
        { ...base, id: "dm", kind: 10050, tags: [["relay", "wss://dm.example"]] },
        { ...base, id: "media", kind: 10063, tags: [["server", "https://media.example/"]] },
      ])
      .mockResolvedValue([]);

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(h.config.searchRelays).toEqual(["wss://search.example"]);
    expect(h.config.dmRelays).toEqual(["wss://dm.example"]);
    expect(h.config.blossomServerMetadata).toEqual({
      servers: ["https://media.example/"],
      updatedAt: 20,
    });
    expect(h.queryClient.setQueryData).toHaveBeenCalledWith(
      ["dm-relay-list", PUBKEY],
      expect.objectContaining({ relays: ["wss://dm.example"] }),
    );
  });
});

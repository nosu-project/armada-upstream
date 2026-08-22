import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInitialSync } from "@/hooks/useInitialSync";
import {
  getDmConversationIndexRecords,
  resetDmConversationIndexCache,
} from "@/hooks/useDmConversationIndex";
import {
  DM_CONVERSATIONS_EVENT_TAG,
  dmConversationIndexBucket,
  dmConversationIndexDTag,
} from "@/lib/dmConversationIndex";
import {
  _resetNotificationSettingsAuthorityForTests,
  notificationSettingsReady,
} from "@/lib/notificationSettingsAuthority";

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
  queryExplicitRelaysWithStatus: vi.fn(),
  resolveDmQuery: undefined as ((events: never[]) => void) | undefined,
  nostr: {},
  queryClient: {
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
  },
  readFolded: vi.fn(),
  writeFolded: vi.fn(),
  storeQuery: vi.fn(),
  eventStore: undefined as unknown,
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

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => h.eventStore,
}));

vi.mock("@/lib/foldedCache", () => ({
  readFolded: (...args: unknown[]) => h.readFolded(...args),
  writeFolded: (...args: unknown[]) => h.writeFolded(...args),
}));

vi.mock("@/hooks/useDmRelayList", () => ({
  KIND_DM_RELAYS: 10050,
  parseDmRelays: (event: { tags: string[][] } | undefined) =>
    event?.tags.filter(([name]) => name === "relay").map(([, url]) => url) ?? [],
}));

vi.mock("@/lib/nip65", () => ({
  discoverRelayList: (...args: unknown[]) => h.discoverRelayList(...args),
  KIND_RELAY_LIST: 10002,
  parseRelayList: (event: { tags: string[][] }) => event.tags
    .filter(([name]) => name === "r")
    .map(([, url, marker]) => ({
      url,
      read: marker !== "write",
      write: marker !== "read",
    })),
  queryExplicitRelays: (...args: unknown[]) => h.queryExplicitRelays(...args),
  queryExplicitRelaysWithStatus: (...args: unknown[]) => h.queryExplicitRelaysWithStatus(...args),
  relayListIsNewerThanMetadata: (
    candidate: { created_at: number; id: string },
    current: { updatedAt: number; eventId?: string },
  ) => candidate.created_at > current.updatedAt
    || (candidate.created_at === current.updatedAt
      && (current.eventId === undefined || candidate.id < current.eventId)),
  uniqueRelayUrls: (urls: Iterable<string>) => [...new Set(urls)],
}));

describe("useInitialSync", () => {
  beforeEach(async () => {
    localStorage.clear();
    _resetNotificationSettingsAuthorityForTests();
    await resetDmConversationIndexCache();
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
      event: { id: "relay", created_at: 10 },
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
    h.queryExplicitRelaysWithStatus.mockReset().mockImplementation(async (...args: unknown[]) => ({
      events: await h.queryExplicitRelays(...args),
      answered: [RELAY],
      failed: [],
    }));
    h.resolveDmQuery = undefined;
    h.queryClient.setQueryData.mockClear();
    h.queryClient.getQueryData.mockReset().mockReturnValue(undefined);
    h.readFolded.mockReset().mockResolvedValue(undefined);
    h.writeFolded.mockReset().mockResolvedValue(undefined);
    h.storeQuery.mockReset().mockResolvedValue([]);
    h.eventStore = Promise.resolve({ query: h.storeQuery });
    h.user.signer = {};
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
      eventId: "media",
    });
    expect(h.queryClient.setQueryData).toHaveBeenCalledWith(
      ["dm-relay-list", PUBKEY],
      expect.objectContaining({ relays: ["wss://dm.example"] }),
    );
  });

  it("adopts a newer NIP-65 pointer cached by the native background service", async () => {
    h.discoverRelayList.mockResolvedValue({
      event: {
        pubkey: PUBKEY,
        id: "f".repeat(64),
        kind: 10002,
        sig: "s",
        content: "",
        created_at: 20,
        tags: [["r", "wss://stale-pointer.example"]],
      },
      relays: [{ url: "wss://stale-pointer.example", read: true, write: true }],
    });
    h.storeQuery.mockResolvedValue([{
      pubkey: PUBKEY,
      id: "0".repeat(64),
      kind: 10002,
      content: "",
      created_at: 30,
      tags: [["r", "wss://native-pointer.example"]],
    }]);
    h.queryExplicitRelays.mockReset().mockResolvedValue([]);

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(h.config.relayMetadata).toEqual({
      relays: [{ url: "wss://native-pointer.example", read: true, write: true }],
      updatedAt: 30,
      eventId: "0".repeat(64),
      pubkey: PUBKEY,
    });
    expect(h.config.useUserRelays).toBe(true);
  });

  it("prefers ArmadaDB canonical lists to stale wire copies, including equal-second ties", async () => {
    const wireBase = {
      pubkey: PUBKEY,
      content: "",
      sig: "s",
      created_at: 20,
    };
    h.queryExplicitRelays.mockReset()
      .mockResolvedValueOnce([
        {
          ...wireBase,
          id: "wire-search",
          kind: 10007,
          tags: [["relay", "wss://stale-search.example"]],
        },
        {
          ...wireBase,
          id: "f".repeat(64),
          kind: 10050,
          tags: [["relay", "wss://stale-dm.example"]],
        },
        {
          ...wireBase,
          id: "wire-media",
          kind: 10063,
          tags: [["server", "https://stale-media.example/"]],
        },
      ])
      .mockResolvedValue([]);
    h.storeQuery.mockResolvedValue([
      {
        ...wireBase,
        id: "local-search",
        sig: undefined,
        created_at: 30,
        kind: 10007,
        tags: [["relay", "wss://local-search.example"]],
      },
      {
        ...wireBase,
        id: "0".repeat(64),
        sig: undefined,
        kind: 10050,
        tags: [["relay", "wss://local-dm.example"]],
      },
      {
        ...wireBase,
        id: "local-media",
        sig: undefined,
        created_at: 30,
        kind: 10063,
        tags: [["server", "https://local-media.example/"]],
      },
    ]);

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(h.config.searchRelays).toEqual(["wss://local-search.example"]);
    expect(h.config.dmRelays).toEqual(["wss://local-dm.example"]);
    expect(h.config.blossomServerMetadata).toEqual({
      servers: ["https://local-media.example/"],
      updatedAt: 30,
      eventId: "local-media",
    });
  });

  it("restores pre-10007 search/DM/media values from the NIP-78 blob when no canonical list exists", async () => {
    const legacy = {
      searchRelays: ["wss://legacy-search.example"],
      dmRelays: ["wss://legacy-dm.example"],
      blossomServerMetadata: { servers: ["https://legacy-media.example/"], updatedAt: 7 },
    };
    const priorSigner = h.user.signer;
    h.user.signer = { nip44: { decrypt: vi.fn(async () => JSON.stringify(legacy)) } };

    h.queryExplicitRelays.mockReset()
      // 1. No canonical kind-10007/10050/10063 lists exist for this account.
      .mockResolvedValueOnce([])
      // 2. The encrypted settings blob still carries the pre-migration values.
      .mockResolvedValueOnce([
        {
          pubkey: PUBKEY,
          id: "settings",
          kind: 30078,
          sig: "s",
          created_at: 30,
          tags: [["d", "armada/metadata"]],
          content: "cipher",
        },
      ])
      .mockResolvedValue([]);

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(h.config.searchRelays).toEqual(["wss://legacy-search.example"]);
    expect(h.config.dmRelays).toEqual(["wss://legacy-dm.example"]);
    expect(h.config.blossomServerMetadata).toEqual({
      servers: ["https://legacy-media.example/"],
      updatedAt: 7,
    });

    h.user.signer = priorSigner;
  });

  it("seeds the lower-id NIP-01 winner when settings collide in one second", async () => {
    h.user.signer = {
      nip44: { decrypt: vi.fn(async () => "{}") },
    };
    const base = {
      pubkey: PUBKEY,
      kind: 30078,
      sig: "s",
      created_at: 30,
      tags: [["d", "armada/metadata"]],
      content: "cipher",
    };
    h.queryExplicitRelays.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ...base, id: "f".repeat(64) },
        { ...base, id: "0".repeat(64) },
      ])
      .mockResolvedValue([]);

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(h.queryClient.setQueryData).toHaveBeenCalledWith(
      ["settings-doc", "metadata", PUBKEY],
      expect.objectContaining({ event: expect.objectContaining({ id: "0".repeat(64) }) }),
    );
  });

  it("marks explicit empty notification settings authoritative only after every self relay answers", async () => {
    h.user.signer = { nip44: { decrypt: vi.fn() } };
    h.queryExplicitRelays.mockReset().mockResolvedValue([]);

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(notificationSettingsReady(PUBKEY)).toBe(true);
  });

  it("does not authorize defaults when a declared self relay fails", async () => {
    h.user.signer = { nip44: { decrypt: vi.fn() } };
    h.queryExplicitRelays.mockReset().mockResolvedValue([]);
    h.queryExplicitRelaysWithStatus.mockImplementationOnce(async (...args: unknown[]) => ({
      events: await h.queryExplicitRelays(...args),
      answered: [],
      failed: [RELAY],
    }));

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(notificationSettingsReady(PUBKEY)).toBe(false);
  });

  it("hydrates the encrypted DM index before the login gate completes", async () => {
    const peer = "b".repeat(64);
    const entry = {
      key: peer,
      latest: { createdAt: 44, id: "c".repeat(64) },
      mine: true,
    };
    const bucket = dmConversationIndexBucket(peer);
    const payload = { version: 1, deviceId: "other-device", bucket, records: [entry] };
    h.user.signer = {
      nip44: {
        decrypt: vi.fn(async () => JSON.stringify(payload)),
      },
    };
    h.queryExplicitRelays.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        pubkey: PUBKEY,
        id: "d".repeat(64),
        kind: 30078,
        sig: "s",
        created_at: 40,
        tags: [
          ["d", dmConversationIndexDTag(payload.deviceId, bucket)],
          ["t", DM_CONVERSATIONS_EVENT_TAG],
        ],
        content: "cipher",
      }])
      .mockResolvedValue([]);

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(await getDmConversationIndexRecords(PUBKEY)).toEqual([entry]);
    const settingsFilters = h.queryExplicitRelays.mock.calls[1]?.[2] as Array<Record<string, unknown>>;
    expect(settingsFilters).toContainEqual(expect.objectContaining({
      kinds: [30078],
      authors: [PUBKEY],
      "#t": [DM_CONVERSATIONS_EVENT_TAG],
    }));
  });

  it("keeps the folded last-good group list when the newest decrypt transiently fails", async () => {
    const heldEvent = {
      pubkey: PUBKEY,
      id: "1".repeat(64),
      kind: 10009,
      sig: "s".repeat(128),
      created_at: 10,
      tags: [],
      content: "old-cipher",
    };
    h.readFolded.mockImplementation(async (key: unknown) => key === `nip29-grouplist:${PUBKEY}`
      ? {
          event: heldEvent,
          groups: [{ id: "kept", relay: RELAY }],
          servers: [RELAY],
        }
      : undefined);
    h.user.signer = {
      nip44: { decrypt: vi.fn(async () => { throw new Error("signer unavailable"); }) },
    };
    h.queryExplicitRelays.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        ...heldEvent,
        id: "2".repeat(64),
        created_at: 20,
        content: "new-cipher",
      }])
      .mockResolvedValue([]);

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(h.queryClient.setQueryData).toHaveBeenCalledWith(
      ["nip29", "user-groups", PUBKEY],
      expect.objectContaining({
        event: heldEvent,
        groups: [{ id: "kept", relay: RELAY }],
        servers: [RELAY],
        decryptFailed: false,
      }),
    );
  });

  it("prefers a newer native-cached server list to a stale relay copy", async () => {
    const base = {
      pubkey: PUBKEY,
      kind: 10009,
      content: "",
      created_at: 20,
      tags: [["r", "wss://stale-server.example"]],
    };
    h.queryExplicitRelays.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        ...base,
        id: "f".repeat(64),
        sig: "s",
      }])
      .mockResolvedValue([]);
    h.storeQuery.mockResolvedValue([{
      ...base,
      id: "0".repeat(64),
      created_at: 30,
      tags: [["r", "wss://native-server.example"]],
    }]);

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(h.queryClient.setQueryData).toHaveBeenCalledWith(
      ["nip29", "user-groups", PUBKEY],
      expect.objectContaining({
        event: expect.objectContaining({ id: "0".repeat(64) }),
        servers: ["wss://native-server.example"],
      }),
    );
  });
});

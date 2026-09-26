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

/**
 * Route queryExplicitRelays responses by the first filter's kind rather than by
 * call order. The post-relay phases now run CONCURRENTLY (settings, the NIP-29
 * group list and Concord fire in parallel), so the order a test's reads arrive
 * in is no longer fixed — dispatching on kind keeps each read's mocked payload
 * attached to the read it belongs to.
 */
const SERVICE_LIST_KINDS = [10007, 10050, 10063];
function respondByKind(byKind: {
  settings?: unknown[];
  groups?: unknown[];
  service?: unknown[];
}): void {
  h.queryExplicitRelays.mockReset().mockImplementation(async (...args: unknown[]) => {
    const filters = (args[2] ?? []) as Array<{ kinds?: number[] }>;
    const kinds = filters.flatMap((f) => f.kinds ?? []);
    if (kinds.includes(30078)) return byKind.settings ?? [];
    if (kinds.includes(10009)) return byKind.groups ?? [];
    if (kinds.some((k) => SERVICE_LIST_KINDS.includes(k))) return byKind.service ?? [];
    return [];
  });
}

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

    // No canonical kind-10007/10050/10063 lists exist; the encrypted settings
    // blob still carries the pre-migration values.
    respondByKind({
      settings: [
        {
          pubkey: PUBKEY,
          id: "settings",
          kind: 30078,
          sig: "s",
          created_at: 30,
          tags: [["d", "armada/metadata"]],
          content: "cipher",
        },
      ],
    });

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
    respondByKind({
      settings: [
        { ...base, id: "f".repeat(64) },
        { ...base, id: "0".repeat(64) },
      ],
    });

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

  it("hydrates the encrypted DM index from the login read", async () => {
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
    respondByKind({
      settings: [{
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
      }],
    });

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    await waitFor(async () => expect(await getDmConversationIndexRecords(PUBKEY)).toEqual([entry]));
    const settingsCall = h.queryExplicitRelays.mock.calls.find(
      (call) => ((call[2] ?? []) as Array<{ kinds?: number[] }>).some((f) => f.kinds?.includes(30078)),
    );
    const settingsFilters = settingsCall?.[2] as Array<Record<string, unknown>>;
    expect(settingsFilters).toContainEqual(expect.objectContaining({
      kinds: [30078],
      authors: [PUBKEY],
      "#t": [DM_CONVERSATIONS_EVENT_TAG],
    }));
  });

  it("restores the metadata document while DM index decrypts are still pending", async () => {
    const shardCipher = "shard-cipher";
    h.user.signer = {
      nip44: {
        // A DM index shard decrypt that never settles: the gate must not wait on it.
        decrypt: vi.fn((_pk: string, content: string) => content === shardCipher
          ? new Promise<string>(() => undefined)
          : Promise.resolve(JSON.stringify({ theme: "light" }))),
      },
    };
    respondByKind({
      settings: [
        {
          pubkey: PUBKEY,
          id: "d".repeat(64),
          kind: 30078,
          sig: "s",
          created_at: 40,
          tags: [
            ["d", dmConversationIndexDTag("other-device", 0)],
            ["t", DM_CONVERSATIONS_EVENT_TAG],
          ],
          content: shardCipher,
        },
        {
          pubkey: PUBKEY,
          id: "e".repeat(64),
          kind: 30078,
          sig: "s",
          created_at: 41,
          tags: [["d", "armada/metadata"]],
          content: "metadata-cipher",
        },
      ],
    });

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(view.result.current.log.find((line) => line.id === "settings")?.status).toBe("RESTORED");
    expect(h.queryClient.setQueryData).toHaveBeenCalledWith(
      ["settings-doc", "metadata", PUBKEY],
      expect.objectContaining({ doc: expect.objectContaining({ theme: "light" }) }),
    );
  });

  it("restores the theme from a metadata document carrying one invalid field", async () => {
    h.user.signer = {
      nip44: {
        decrypt: vi.fn(async () => JSON.stringify({ theme: "light", defaultZapMethod: "not-a-method" })),
      },
    };
    respondByKind({
      settings: [{
        pubkey: PUBKEY,
        id: "e".repeat(64),
        kind: 30078,
        sig: "s",
        created_at: 41,
        tags: [["d", "armada/metadata"]],
        content: "metadata-cipher",
      }],
    });

    const view = renderHook(() => useInitialSync(PUBKEY));
    await waitFor(() => expect(view.result.current.done).toBe(true));

    expect(view.result.current.log.find((line) => line.id === "settings")?.status).toBe("RESTORED");
    const seeded = h.queryClient.setQueryData.mock.calls.find(
      ([key]) => JSON.stringify(key) === JSON.stringify(["settings-doc", "metadata", PUBKEY]),
    )?.[1] as { doc: Record<string, unknown> } | undefined;
    expect(seeded?.doc.theme).toBe("light");
    expect(seeded?.doc).not.toHaveProperty("defaultZapMethod");
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

  it("holds the gate past the budget when the settings branch is wedged, lifting only at the hard cap", async () => {
    // Settings is the priority: a wedged settings branch must NOT let the budget
    // lift the gate onto a pre-settings default theme/relay set. The absolute
    // hard cap (SYNC_TIMEOUT_MS + SETTINGS_PRIORITY_GRACE_MS) is the only
    // backstop against a branch that ignores its own abort.
    vi.useFakeTimers();
    try {
      h.user.signer = { nip44: { decrypt: vi.fn(async () => "{}") } };
      // The settings branch hangs forever on its service-list read, ignoring abort.
      h.queryExplicitRelays.mockReset().mockImplementation((...args: unknown[]) => {
        const kinds = ((args[2] ?? []) as Array<{ kinds?: number[] }>).flatMap((f) => f.kinds ?? []);
        if (kinds.some((k) => SERVICE_LIST_KINDS.includes(k))) return new Promise<never[]>(() => {});
        return Promise.resolve([]);
      });
      h.queryExplicitRelaysWithStatus.mockImplementation(async (...args: unknown[]) => ({
        events: await h.queryExplicitRelays(...args),
        answered: [RELAY],
        failed: [],
      }));

      const view = renderHook(() => useInitialSync(PUBKEY));

      // Past the 30s budget the gate is STILL up: settings has not settled, and
      // the budget defers to it rather than lifting onto defaults.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(view.result.current.done).toBe(false);

      // Only at the hard cap (30s budget + 16s grace) does it lift despite the wedge.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16_000);
      });
      expect(view.result.current.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lifts the gate at the budget when a non-settings branch is wedged and settings has settled", async () => {
    // The budget still bounds the slower work: a wedged group/warm-up branch
    // does not hold the gate once settings — the priority — has settled. This is
    // the whole point of the budget, preserved for everything but settings.
    vi.useFakeTimers();
    try {
      h.user.signer = { nip44: { decrypt: vi.fn(async () => "{}") } };
      // The NIP-29 group read hangs forever; settings and the rest resolve.
      h.queryExplicitRelays.mockReset().mockImplementation((...args: unknown[]) => {
        const kinds = ((args[2] ?? []) as Array<{ kinds?: number[] }>).flatMap((f) => f.kinds ?? []);
        if (kinds.includes(10009)) return new Promise<never[]>(() => {});
        return Promise.resolve([]);
      });
      h.queryExplicitRelaysWithStatus.mockImplementation(async (...args: unknown[]) => ({
        events: await h.queryExplicitRelays(...args),
        answered: [RELAY],
        failed: [],
      }));

      const view = renderHook(() => useInitialSync(PUBKEY));

      // Before the budget the gate is up, the wedged group branch still running.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(view.result.current.done).toBe(false);

      // At the budget the gate lifts: settings settled early, so the wedged group
      // branch is left to finish in the background.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(view.result.current.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

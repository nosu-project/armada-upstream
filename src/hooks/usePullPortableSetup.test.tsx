import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import { settingsDTag } from "@/lib/settingsDocs";
import { fragment, serializeFragList } from "@/concord/lib/listFrag";
import type { NostrRumor } from "@/lib/nostrRumor";

import { usePullPortableSetup } from "./usePullPortableSetup";

const PUBKEY = "a".repeat(64);
const OLD_RELAY = "wss://old.example";
const NEW_RELAY = "wss://new.example";

/**
 * The store behaviour this hook depends on: NIP-01 addressable supersession,
 * so "what is on disk" is the newest version this device has ever seen. The
 * pull compares relay copies against it before applying one.
 */
class FakeStore {
  rumors: NostrRumor[] = [];

  async event(event: NostrEvent): Promise<void> {
    const { sig: _sig, ...rumor } = event;
    const coord = `${rumor.kind}:${rumor.pubkey}:${dTagOf(rumor) ?? ""}`;
    const index = this.rumors.findIndex(
      (held) => `${held.kind}:${held.pubkey}:${dTagOf(held) ?? ""}` === coord,
    );
    if (index === -1) {
      this.rumors.push(rumor);
      return;
    }
    if (rumor.created_at > this.rumors[index]!.created_at) this.rumors[index] = rumor;
  }

  async query([filter]: NostrFilter[]): Promise<NostrRumor[]> {
    return this.rumors.filter((rumor) =>
      (filter!.kinds?.includes(rumor.kind) ?? true)
      && (filter!.authors?.includes(rumor.pubkey) ?? true)
      && (!filter!["#d"] || filter!["#d"]!.includes(dTagOf(rumor) ?? "")));
  }

  async count() {
    return { count: this.rumors.length };
  }
  async remove() {}
  async close() {}
}

function dTagOf(rumor: { tags: string[][] }): string | undefined {
  return rumor.tags.find(([name]) => name === "d")?.[1];
}

/** NIP-44 stand-in: reversible, and obviously not a real ciphertext. */
const nip44 = {
  encrypt: async (_pubkey: string, plaintext: string) => `sealed:${plaintext}`,
  decrypt: vi.fn(async (_pubkey: string, ciphertext: string) => {
    if (!ciphertext.startsWith("sealed:")) throw new Error("not for this key");
    return ciphertext.slice("sealed:".length);
  }),
};

let store: FakeStore;
/** `setQueryData` / `invalidateQueries` calls in the order they happened. */
let timeline: string[];

const h = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  updateConfig: vi.fn(),
  discoverRelayList: vi.fn(),
  queryExplicitRelays: vi.fn(),
  readFolded: vi.fn(),
  writeFolded: vi.fn(),
  hasNip44: true,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: {} }),
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config, updateConfig: h.updateConfig }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    user: {
      pubkey: PUBKEY,
      signer: h.hasNip44 ? { nip44 } : {},
    },
  }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve(store),
}));

vi.mock("@/lib/foldedCache", () => ({
  readFolded: (...args: unknown[]) => h.readFolded(...args),
  writeFolded: (...args: unknown[]) => h.writeFolded(...args),
}));

vi.mock("@/lib/nip65", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nip65")>();
  return {
    ...actual,
    discoverRelayList: (...args: unknown[]) => h.discoverRelayList(...args),
    queryExplicitRelays: (...args: unknown[]) => h.queryExplicitRelays(...args),
    queryExplicitRelaysWithStatus: async (...args: unknown[]) => ({
      events: await h.queryExplicitRelays(...args),
      answered: args[1] as string[],
      failed: [],
    }),
  };
});

function event(
  kind: number,
  id: string,
  tags: string[][] = [],
  content = "",
  createdAt = 20,
): NostrEvent {
  return { id, pubkey: PUBKEY, kind, created_at: createdAt, tags, content, sig: "sig" };
}

function settingsEvent(
  name: Parameters<typeof settingsDTag>[0],
  doc: Record<string, unknown>,
  createdAt = 20,
): NostrEvent {
  return event(
    30078,
    `settings-${name}-${createdAt}`,
    [["d", settingsDTag(name)]],
    `sealed:${JSON.stringify(doc)}`,
    createdAt,
  );
}

/** The full happy-path answer from the account relays. */
function fullSetup(): NostrEvent[] {
  return [
    event(10009, "groups", [["group", "team", "wss://server.example"], ["r", "wss://server.example"]]),
    event(10007, "search", [["relay", "wss://search.example"]]),
    event(10050, "dm", [["relay", "wss://dm.example"]]),
    event(10063, "media", [["server", "https://media.example/"]]),
    settingsEvent("metadata", { theme: "dark", preferredVoiceServer: "voice.example" }),
    settingsEvent("rail", { railLayout: [{ type: "item", key: "team" }] }),
    settingsEvent("read-state", { readState: { "dm:abc": 99 } }),
  ];
}

/**
 * Render against a REAL QueryClient and the REAL `useNip65RelaySetup`, so the
 * cache keys the pull writes are the ones the app reads, and `adopt`'s
 * deferred invalidation actually runs.
 */
function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const setQueryData = client.setQueryData.bind(client);
  vi.spyOn(client, "setQueryData").mockImplementation(((key: unknown, value: unknown) => {
    timeline.push(`set:${JSON.stringify(key)}`);
    return setQueryData(key as never, value as never);
  }) as typeof client.setQueryData);
  const invalidateQueries = client.invalidateQueries.bind(client);
  vi.spyOn(client, "invalidateQueries").mockImplementation(((filters: unknown) => {
    timeline.push(`invalidate:${JSON.stringify((filters as { queryKey: unknown }).queryKey)}`);
    return invalidateQueries(filters as never);
  }) as typeof client.invalidateQueries);

  const view = renderHook(() => usePullPortableSetup(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { view, client };
}

/** The config `updateConfig` would have produced, folding every call in order. */
function appliedConfig(): Record<string, unknown> {
  let next = h.config;
  for (const [updater] of h.updateConfig.mock.calls) {
    next = (updater as (current: unknown) => Record<string, unknown>)(next);
  }
  return next;
}

beforeEach(() => {
  store = new FakeStore();
  timeline = [];
  h.hasNip44 = true;
  h.config = {
    appRelays: [],
    useAppRelays: false,
    useUserRelays: true,
    searchRelays: [],
    dmRelays: [],
    closedDms: {},
    pinnedDms: [],
    acceptedDms: [],
    startedDms: [],
    blossomServerMetadata: { servers: [], updatedAt: 0 },
    relayMetadata: {
      pubkey: PUBKEY,
      updatedAt: 10,
      relays: [{ url: OLD_RELAY, read: true, write: true }],
    },
  };
  h.updateConfig.mockReset();
  h.discoverRelayList.mockReset().mockResolvedValue({
    event: event(10002, "relay-list", [["r", NEW_RELAY]], "", 30),
    relays: [{ url: NEW_RELAY, read: true, write: true }],
  });
  h.queryExplicitRelays.mockReset().mockResolvedValue(fullSetup());
  h.writeFolded.mockReset().mockResolvedValue(undefined);
  h.readFolded.mockReset().mockResolvedValue(undefined);
  nip44.decrypt.mockClear();
});

describe("usePullPortableSetup", () => {
  it("reads every portable record from the account relays and applies it", async () => {
    const { view, client } = render();
    let result: Awaited<ReturnType<typeof view.result.current.pull>> | undefined;

    await act(async () => {
      result = await view.result.current.pull();
    });

    // Discovery bootstraps off the write relays we already know, and the read
    // then asks both the old and the newly-discovered set.
    expect(h.discoverRelayList.mock.calls[0]?.[2]).toContain(OLD_RELAY);
    expect(h.queryExplicitRelays.mock.calls[0]?.[1]).toEqual([OLD_RELAY, NEW_RELAY]);

    // Every settings document in one filter, with no `limit` — which caps the
    // filter rather than each `d`, so five of six could come back missing.
    const settingsFilter = (h.queryExplicitRelays.mock.calls[0]?.[2] as NostrFilter[])
      .find((filter) => filter.kinds?.includes(30078));
    expect(settingsFilter?.["#d"]).toEqual([
      "metadata", "rail", "read-state", "notifications", "dms", "reactions",
    ].map((name) => settingsDTag(name as never)));
    expect(settingsFilter?.limit).toBeUndefined();

    // The caches the app actually reads.
    expect(client.getQueryData(["nip29", "user-groups", PUBKEY])).toMatchObject({
      servers: ["wss://server.example"],
      decryptFailed: false,
    });
    expect(client.getQueryData(["search-relay-list", PUBKEY])).toMatchObject({
      relays: ["wss://search.example"],
    });
    expect(client.getQueryData(["dm-relay-list", PUBKEY])).toMatchObject({
      relays: ["wss://dm.example"],
    });
    expect(client.getQueryData(["blossom-server-list", PUBKEY])).toMatchObject({
      servers: ["https://media.example/"],
    });
    expect(client.getQueryData(["settings-doc", "metadata", PUBKEY])).toMatchObject({
      doc: { theme: "dark", preferredVoiceServer: "voice.example" },
    });
    expect(client.getQueryData(["settings-doc", "read-state", PUBKEY])).toMatchObject({
      doc: { readState: { "dm:abc": 99 } },
    });

    // …and on disk, so the next read from the store doesn't hand the previous
    // version straight back to the cache.
    expect(store.rumors.map((rumor) => dTagOf(rumor))).toEqual([
      settingsDTag("metadata"), settingsDTag("rail"), settingsDTag("read-state"),
    ]);

    // The config mirrors, which no list hook owns.
    expect(appliedConfig()).toMatchObject({
      searchRelays: ["wss://search.example"],
      dmRelays: ["wss://dm.example"],
      blossomServerMetadata: { servers: ["https://media.example/"], updatedAt: 20 },
      theme: "dark",
      preferredVoiceServer: "voice.example",
      railLayout: [{ type: "item", key: "team" }],
    });

    expect(result).toEqual({ records: 8, sources: 2, voiceServer: true, publicOnly: false });
  });

  it("restores exact 33302 vault fragments and the encrypted 13303 creator list", async () => {
    const [frag] = fragment({
      entries: [],
      tombstones: [{ community_id: "b".repeat(64), removed_at: 123 }],
    });
    const communityEvent = event(
      33302,
      "community-frag",
      [["d", "0"]],
      `sealed:${serializeFragList(frag)}`,
      40,
    );
    const inviteEvent = event(
      13303,
      "invite-list",
      [],
      `sealed:${JSON.stringify({
        entries: [{
          token: "01".repeat(16),
          signer_sk: "02".repeat(32),
          community_id: "c".repeat(64),
          url: "https://armada.buzz/invite/example#secret",
          created_at: 40,
        }],
        tombstones: [],
      })}`,
      40,
    );
    h.queryExplicitRelays.mockResolvedValue([...fullSetup(), communityEvent, inviteEvent]);
    const { view, client } = render();

    await act(async () => {
      await view.result.current.pull();
    });

    expect(client.getQueryData(["concord", "list", PUBKEY])).toMatchObject({
      list: { tombstones: [{ community_id: "b".repeat(64), removed_at: 123 }] },
    });
    expect(client.getQueryData(["concord", "invite-list", PUBKEY])).toMatchObject({
      entries: [{ token: "01".repeat(16), signer_sk: "02".repeat(32) }],
    });
    expect(store.rumors.some((rumor) => rumor.id === communityEvent.id && rumor.kind === 33302)).toBe(true);
    expect(store.rumors.some((rumor) => rumor.id === inviteEvent.id && rumor.kind === 13303)).toBe(true);
  });

  it("merges stale pulled invites with the durable signer-secret fold", async () => {
    const remoteToken = "01".repeat(16);
    const localToken = "03".repeat(16);
    const communityId = "c".repeat(64);
    const inviteEvent = event(
      13303,
      "stale-invite-list",
      [],
      `sealed:${JSON.stringify({
        entries: [{
          token: remoteToken,
          signer_sk: "02".repeat(32),
          community_id: communityId,
          url: "https://armada.buzz/invite/remote#secret",
          created_at: 20,
        }],
        tombstones: [],
      })}`,
      20,
    );
    h.queryExplicitRelays.mockResolvedValue([...fullSetup(), inviteEvent]);
    h.readFolded.mockImplementation(async (key: string) => key.startsWith("concord2-invite-list:")
      ? {
          newestCreatedAt: 30,
          list: {
            entries: [{
              token: localToken,
              signer_sk: "04".repeat(32),
              community_id: communityId,
              url: "https://armada.buzz/invite/local#secret",
              created_at: 30,
            }],
            tombstones: [{ token: remoteToken, community_id: communityId }],
          },
        }
      : undefined);
    const { view, client } = render();

    await act(async () => {
      await view.result.current.pull();
    });

    expect(client.getQueryData(["concord", "invite-list", PUBKEY])).toMatchObject({
      entries: [{ token: localToken, signer_sk: "04".repeat(32) }],
      tombstones: [{ token: remoteToken, community_id: communityId }],
    });
  });

  it("does not let a stale pulled 10009 replace the folded last-good server list", async () => {
    const held = event(
      10009,
      "held-groups",
      [["group", "kept", "wss://kept.example"], ["r", "wss://kept.example"]],
      "",
      40,
    );
    h.readFolded.mockImplementation(async (key: string) => key.startsWith("nip29-grouplist:")
      ? {
          event: held,
          groups: [{ id: "kept", relay: "wss://kept.example" }],
          servers: ["wss://kept.example"],
        }
      : undefined);
    const { view, client } = render();

    await act(async () => {
      await view.result.current.pull();
    });

    expect(client.getQueryData(["nip29", "user-groups", PUBKEY])).toMatchObject({
      event: held,
      groups: [{ id: "kept", relay: "wss://kept.example" }],
      servers: ["wss://kept.example"],
      decryptFailed: false,
    });
  });

  it("chooses the NIP-01 winner across ArmadaDB and stale wire singletons", async () => {
    await store.event(event(10002, "local-pointer", [["r", "wss://local-home.example"]], "", 50));
    await store.event(event(10007, "local-search", [["relay", "wss://local-search.example"]], "", 50));
    await store.event(event(10050, "local-dm", [["relay", "wss://local-dm.example"]], "", 50));
    await store.event(event(10063, "local-media", [["server", "https://local-media.example/"]], "", 50));
    const { view, client } = render();

    await act(async () => {
      await view.result.current.pull();
    });

    expect(client.getQueryData(["search-relay-list", PUBKEY])).toMatchObject({
      event: { id: "local-search" },
      relays: ["wss://local-search.example"],
    });
    expect(client.getQueryData(["dm-relay-list", PUBKEY])).toMatchObject({
      event: { id: "local-dm" },
      relays: ["wss://local-dm.example"],
    });
    expect(client.getQueryData(["blossom-server-list", PUBKEY])).toMatchObject({
      event: { id: "local-media" },
      servers: ["https://local-media.example/"],
    });
    expect(appliedConfig()).toMatchObject({
      relayMetadata: {
        eventId: "local-pointer",
        relays: [{ url: "wss://local-home.example", read: true, write: true }],
      },
      searchRelays: ["wss://local-search.example"],
      dmRelays: ["wss://local-dm.example"],
      blossomServerMetadata: { servers: ["https://local-media.example/"], updatedAt: 50 },
    });
  });

  it("decrypts each topic shard only once before hydrating the decoded result", async () => {
    const gifCiphertext = `sealed:${JSON.stringify({
      version: 1,
      deviceId: "remote-device",
      records: [],
    })}`;
    h.queryExplicitRelays.mockResolvedValue([
      ...fullSetup(),
      event(
        30078,
        "gif-shard",
        [["d", "armada/gif-favorites/remote-device"], ["t", "armada-gif-favorites"]],
        gifCiphertext,
        40,
      ),
    ]);
    const { view } = render();

    await act(async () => {
      await view.result.current.pull();
    });

    expect(nip44.decrypt.mock.calls.filter(([, content]) => content === gifCiphertext)).toHaveLength(1);
  });

  /**
   * `adopt` schedules an invalidation of every self-owned query key for the
   * next macrotask. Seeding before that fires hands the newly-adopted pool a
   * refetch that overwrites everything this pull just read.
   */
  it("adopts the relay map before seeding, so the seeds survive its invalidation", async () => {
    const { view } = render();

    await act(async () => {
      await view.result.current.pull();
    });

    const lastInvalidate = timeline.findLastIndex((entry) => entry.startsWith("invalidate:"));
    const firstSeed = timeline.findIndex((entry) => entry.startsWith("set:"));
    expect(lastInvalidate).toBeGreaterThanOrEqual(0);
    expect(firstSeed).toBeGreaterThan(lastInvalidate);
  });

  it("does not clear local caches when no remote setup is found", async () => {
    h.discoverRelayList.mockResolvedValue(undefined);
    h.queryExplicitRelays.mockResolvedValue([]);
    const { view, client } = render();

    await expect(act(async () => view.result.current.pull())).rejects.toThrow(
      "No portable setup was found",
    );

    expect(client.getQueryData(["dm-relay-list", PUBKEY])).toBeUndefined();
    expect(h.updateConfig).not.toHaveBeenCalled();
    expect(timeline).toEqual([]);
  });

  it("applies nothing when a private record cannot be decrypted", async () => {
    h.queryExplicitRelays.mockResolvedValue([
      // A 10009 whose private items were sealed to some other key.
      event(10009, "groups", [], "not-for-this-key"),
      ...fullSetup().slice(1),
    ]);
    const { view, client } = render();

    await expect(act(async () => view.result.current.pull())).rejects.toThrow(
      "server list could not be decrypted",
    );

    expect(client.getQueryData(["dm-relay-list", PUBKEY])).toBeUndefined();
    expect(client.getQueryData(["settings-doc", "metadata", PUBKEY])).toBeUndefined();
    expect(h.updateConfig).not.toHaveBeenCalled();
    expect(store.rumors).toEqual([]);
  });

  /**
   * A signer without NIP-44 can still restore the records that carry no
   * ciphertext; refusing the whole pull would cost it its relay map and its
   * DM/media lists over documents it was never going to read.
   */
  it("restores the public records on a signer that cannot decrypt", async () => {
    h.hasNip44 = false;
    const { view, client } = render();
    let result: Awaited<ReturnType<typeof view.result.current.pull>> | undefined;

    await act(async () => {
      result = await view.result.current.pull();
    });

    const filters = h.queryExplicitRelays.mock.calls[0]?.[2] as NostrFilter[];
    expect(filters.some((filter) => filter.kinds?.includes(30078))).toBe(false);
    expect(client.getQueryData(["dm-relay-list", PUBKEY])).toMatchObject({
      relays: ["wss://dm.example"],
    });
    expect(client.getQueryData(["search-relay-list", PUBKEY])).toBeUndefined();
    expect(client.getQueryData(["nip29", "user-groups", PUBKEY])).toBeUndefined();
    expect(result).toMatchObject({ publicOnly: true, voiceServer: false });
  });

  /**
   * ArmadaDB is the model for the settings documents. A relay copy that isn't
   * strictly newer than what is on disk is counted as found, but never applied
   * — the store would refuse it anyway, and seeding the cache with it would
   * regress a version this device has already acted on.
   */
  it("does not apply a settings document older than the one on disk", async () => {
    await store.event(settingsEvent("metadata", { theme: "light" }, 300));
    const { view, client } = render();
    let result: Awaited<ReturnType<typeof view.result.current.pull>> | undefined;

    await act(async () => {
      result = await view.result.current.pull();
    });

    expect(client.getQueryData(["settings-doc", "metadata", PUBKEY])).toBeUndefined();
    expect(appliedConfig().theme).toBeUndefined();
    // Still counted: the relay has the document, it is simply behind.
    expect(result?.records).toBe(8);
    expect(result?.voiceServer).toBe(false);
  });

  it("applies an equal-second lower-id settings winner over the stored loser", async () => {
    const local = {
      ...settingsEvent("metadata", { theme: "light" }, 300),
      id: "f".repeat(64),
    };
    const remote = {
      ...settingsEvent("metadata", { theme: "dark" }, 300),
      id: "0".repeat(64),
    };
    await store.event(local);
    h.queryExplicitRelays.mockResolvedValue([
      ...fullSetup().filter((candidate) =>
        candidate.tags.find(([name]) => name === "d")?.[1] !== settingsDTag("metadata")),
      remote,
    ]);
    const { view, client } = render();

    await act(async () => {
      await view.result.current.pull();
    });

    expect(client.getQueryData(["settings-doc", "metadata", PUBKEY])).toMatchObject({
      event: { id: remote.id },
      doc: { theme: "dark" },
    });
    expect(appliedConfig().theme).toBe("dark");
  });
});

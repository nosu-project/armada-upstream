import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SELF = "f".repeat(64);
const OLD_RELAY = "wss://old.example";
const NEW_RELAY = "wss://new.example";

interface QueryOptions {
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
}

const h = vi.hoisted(() => ({
  relays: ["wss://old.example"] as string[],
  nip65Relays: ["wss://old.example"] as string[],
  queryData: undefined as unknown,
  queryOptions: undefined as QueryOptions | undefined,
  ownShard: { version: 1, deviceId: "test-device", records: [] } as {
    version: 1;
    deviceId: string;
    records: Array<Record<string, unknown>>;
  },
  dirtyListeners: new Set<(pubkey: string) => void>(),
  publish: vi.fn(),
  relayQuery: vi.fn(),
  storeQuery: vi.fn(async () => []),
  invalidate: vi.fn(),
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: (relay: string) => ({
        query: (filters: unknown, options: unknown) => h.relayQuery(relay, filters, options),
      }),
    },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    h.queryOptions = options;
    return { data: h.queryData };
  },
  useQueryClient: () => ({ invalidateQueries: h.invalidate }),
}));

vi.mock("@/contexts/AppContext", () => ({
  selfStateRelays: () => [...h.relays],
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: {
      automaticSettingsSync: true,
      relayMetadata: {
        pubkey: "f".repeat(64),
        relays: h.nip65Relays.map((url) => ({ url, read: true, write: true })),
      },
    },
  }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    user: {
      pubkey: "f".repeat(64),
      signer: {
        nip44: {
          encrypt: async (_pubkey: string, plaintext: string) => `encrypted:${plaintext}`,
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext,
        },
      },
    },
  }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: h.storeQuery }),
}));

vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publish }),
}));

vi.mock("@/hooks/useFavoriteGifs", () => ({
  claimLegacyFavoriteGifs: () => ({ hadLegacy: false, changed: false }),
  completeLegacyFavoriteGifMigration: vi.fn(),
  FAVORITE_GIFS_D_PREFIX: "armada/gif-favorites/",
  FAVORITE_GIFS_EVENT_KIND: 30078,
  FAVORITE_GIFS_EVENT_TAG: "armada-gif-favorites",
  getFavoriteGifShardDTag: () => "armada/gif-favorites/test-device",
  hydrateFavoriteGifShards: vi.fn(),
  loadOwnFavoriteGifShard: () => h.ownShard,
  parseFavoriteGifShard: (value: unknown) => value,
  subscribeFavoriteGifChanges: (listener: (pubkey: string) => void) => {
    h.dirtyListeners.add(listener);
    return () => h.dirtyListeners.delete(listener);
  },
}));

import {
  FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS,
  useFavoriteGifsSync,
} from "@/hooks/useFavoriteGifsSync";

function baseKey(relays: readonly string[], nip65Relays = relays): string {
  return `${SELF}\u0001${[...relays].sort().join("\u0000")}`
    + `\u0002${[...nip65Relays].sort().join("\u0000")}`;
}

function emptyPull(relays: readonly string[], nip65Relays = relays) {
  return {
    shards: [],
    ownEvents: new Map(),
    unreadable: new Set(),
    baseKey: baseKey(relays, nip65Relays),
    publishRelays: [...relays],
  };
}

function changeFavorite(): void {
  h.ownShard.records = [{
    gif: { id: "gif", title: "GIF", url: "https://example.com/gif", width: 1, height: 1 },
    favorite: true,
    updatedAt: 1,
    operationId: "operation",
  }];
  for (const listener of h.dirtyListeners) listener(SELF);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.relays = [OLD_RELAY];
  h.nip65Relays = [OLD_RELAY];
  h.queryData = emptyPull(h.relays);
  h.queryOptions = undefined;
  h.ownShard.records = [];
  h.dirtyListeners.clear();
  h.publish.mockReset().mockResolvedValue(undefined);
  h.relayQuery.mockReset().mockResolvedValue([]);
  h.storeQuery.mockClear();
  h.invalidate.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("favorite GIF self-state relay cohort", () => {
  it("uses an answered app relay when the account has no NIP-65 writer yet", async () => {
    h.relays = [OLD_RELAY];
    h.nip65Relays = [];
    h.queryData = undefined;
    renderHook(() => useFavoriteGifsSync());

    await expect(h.queryOptions!.queryFn({ signal: new AbortController().signal }))
      .resolves.toEqual(expect.objectContaining({ publishRelays: [OLD_RELAY] }));
  });

  it("requires a declared NIP-65 writer to answer", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [NEW_RELAY];
    h.queryData = undefined;
    h.relayQuery.mockImplementation(async (relay: string) => {
      if (relay === NEW_RELAY) throw new Error("offline");
      return [];
    });
    renderHook(() => useFavoriteGifsSync());

    await expect(h.queryOptions!.queryFn({ signal: new AbortController().signal }))
      .rejects.toThrow(/declared NIP-65 write relay/);
  });

  it("publishes only to the relays that answered the canonical pull", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [OLD_RELAY, NEW_RELAY];
    h.queryData = undefined;
    h.relayQuery.mockImplementation(async (relay: string) => {
      if (relay === NEW_RELAY) throw new Error("offline");
      return [];
    });
    const view = renderHook(() => useFavoriteGifsSync());
    h.queryData = await h.queryOptions!.queryFn({ signal: new AbortController().signal });
    view.rerender();
    await act(async () => Promise.resolve());

    await act(async () => {
      changeFavorite();
      await vi.advanceTimersByTimeAsync(FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS);
    });

    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({
      relays: [OLD_RELAY],
      inheritPendingTargets: false,
    }));
    view.unmount();
  });

  it("does not reuse an old pull after the relay set changes", async () => {
    const view = renderHook(() => useFavoriteGifsSync());
    await act(async () => Promise.resolve());

    h.relays = [NEW_RELAY];
    h.nip65Relays = [NEW_RELAY];
    h.queryData = emptyPull([OLD_RELAY]);
    view.rerender();
    await act(async () => {
      changeFavorite();
      await vi.advanceTimersByTimeAsync(FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS);
    });

    expect(h.publish).not.toHaveBeenCalled();
    view.unmount();
  });
});

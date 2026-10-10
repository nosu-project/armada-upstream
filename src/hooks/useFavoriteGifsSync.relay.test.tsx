import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { settingsKeyring } from "@/lib/settingsKeys";

const SELF = "f".repeat(64);
const OLD_RELAY = "wss://old.example";
const NEW_RELAY = "wss://new.example";
const KEYS = { keyring: settingsKeyring("05".repeat(32)), previous: [] };

interface QueryOptions {
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
}

const h = vi.hoisted(() => ({
  relays: ["wss://old.example"] as string[],
  nip65Relays: ["wss://old.example"] as string[],
  queryData: undefined as unknown,
  queryOptions: undefined as QueryOptions | undefined,
  records: [] as Array<Record<string, unknown>>,
  dirtyListeners: new Set<(pubkey: string) => void>(),
  publish: vi.fn(),
  relayQuery: vi.fn(),
  storeQuery: vi.fn(async () => []),
  keys: undefined as unknown,
  ensure: vi.fn(),
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
          encrypt: async (_pubkey: string, plaintext: string) => plaintext,
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext,
        },
      },
    },
  }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: h.storeQuery, event: vi.fn() }),
}));

vi.mock("@/hooks/useSettingsKeys", () => ({
  useSettingsKeys: () => ({ keys: h.keys, isFetched: true, ensure: h.ensure }),
}));

vi.mock("@/lib/selfStatePublish", () => ({
  publishSelfStateEvent: (...args: unknown[]) => h.publish(...args),
}));

vi.mock("@/hooks/useFavoriteGifs", () => ({
  claimLegacyFavoriteGifs: () => ({ hadLegacy: false, changed: false }),
  completeLegacyFavoriteGifMigration: vi.fn(),
  FAVORITE_GIFS_D_PREFIX: "armada/gif-favorites/",
  FAVORITE_GIFS_EVENT_KIND: 30078,
  FAVORITE_GIFS_EVENT_TAG: "armada-gif-favorites",
  getFavoriteGifRecords: () => h.records,
  hydrateFavoriteGifRecords: vi.fn(),
  parseFavoriteGifDoc: (value: unknown) => value,
  parseFavoriteGifShard: (value: unknown) => value,
  readyFavoriteGifShards: async () => undefined,
  subscribeFavoriteGifChanges: (listener: (pubkey: string) => void) => {
    h.dirtyListeners.add(listener);
    return () => h.dirtyListeners.delete(listener);
  },
}));

import {
  FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS,
  useFavoriteGifsSync,
} from "@/hooks/useFavoriteGifsSync";

function changeFavorite(): void {
  h.records = [{
    gif: { id: "gif", title: "GIF", url: "https://example.com/gif", width: 1, height: 1 },
    favorite: true,
    updatedAt: 1,
    operationId: "operation",
  }];
  for (const listener of h.dirtyListeners) listener(SELF);
}

async function pull(view: { rerender: () => void }): Promise<void> {
  h.queryData = await h.queryOptions!.queryFn({ signal: new AbortController().signal });
  view.rerender();
  await act(async () => Promise.resolve());
}

beforeEach(() => {
  vi.useFakeTimers();
  h.relays = [OLD_RELAY];
  h.nip65Relays = [OLD_RELAY];
  h.queryData = undefined;
  h.queryOptions = undefined;
  h.records = [];
  h.keys = KEYS;
  h.dirtyListeners.clear();
  h.publish.mockReset().mockResolvedValue(undefined);
  h.relayQuery.mockReset().mockResolvedValue([]);
  h.storeQuery.mockClear();
  h.ensure.mockReset().mockRejectedValue(new Error("Settings sync has not been set up for this account"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("favorite GIF self-state relay cohort", () => {
  it("uses an answered app relay when the account has no NIP-65 writer yet", async () => {
    h.nip65Relays = [];
    renderHook(() => useFavoriteGifsSync());

    await expect(h.queryOptions!.queryFn({ signal: new AbortController().signal }))
      .resolves.toEqual(expect.objectContaining({ publishRelays: [OLD_RELAY] }));
  });

  it("requires a declared NIP-65 writer to answer", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [NEW_RELAY];
    h.relayQuery.mockImplementation(async (relay: string) => {
      if (relay === NEW_RELAY) throw new Error("offline");
      return [];
    });
    renderHook(() => useFavoriteGifsSync());

    await expect(h.queryOptions!.queryFn({ signal: new AbortController().signal }))
      .rejects.toThrow(/declared NIP-65 write relay/);
  });

  it("reads the shared derived document and the legacy shards", async () => {
    renderHook(() => useFavoriteGifsSync());
    await h.queryOptions!.queryFn({ signal: new AbortController().signal });
    expect(h.relayQuery).toHaveBeenCalledWith(OLD_RELAY, [
      expect.objectContaining({ authors: [KEYS.keyring.gifFavorites.pubkey] }),
      expect.objectContaining({ authors: [SELF], "#t": ["armada-gif-favorites"] }),
    ], expect.anything());
  });

  it("publishes the shared document, under its derived key, only to the relays that answered", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [OLD_RELAY, NEW_RELAY];
    h.relayQuery.mockImplementation(async (relay: string) => {
      if (relay === NEW_RELAY) throw new Error("offline");
      return [];
    });
    const view = renderHook(() => useFavoriteGifsSync());
    await pull(view);

    await act(async () => {
      changeFavorite();
      await vi.advanceTimersByTimeAsync(FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS);
    });

    expect(h.publish).toHaveBeenCalledOnce();
    const [, , event, relays] = h.publish.mock.calls[0]!;
    expect(relays).toEqual([OLD_RELAY]);
    expect(event).toMatchObject({
      pubkey: KEYS.keyring.gifFavorites.pubkey,
      tags: [["d", KEYS.keyring.gifFavorites.d]],
    });
    view.unmount();
  });

  it("publishes nothing and asks for no root when the account has not set up sync", async () => {
    h.keys = { keyring: null, previous: [] };
    const view = renderHook(() => useFavoriteGifsSync());
    await pull(view);
    await act(async () => {
      changeFavorite();
      await vi.advanceTimersByTimeAsync(FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS);
    });

    expect(h.ensure).toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not reuse an old pull after the relay set changes", async () => {
    const view = renderHook(() => useFavoriteGifsSync());
    await pull(view);

    h.relays = [NEW_RELAY];
    h.nip65Relays = [NEW_RELAY];
    view.rerender();
    await act(async () => {
      changeFavorite();
      await vi.advanceTimersByTimeAsync(FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS);
    });

    expect(h.publish).not.toHaveBeenCalled();
    view.unmount();
  });
});

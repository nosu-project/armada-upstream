import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

import { settingsKeyring } from "@/lib/settingsKeys";

const SELF = "f".repeat(64);
const OLD_RELAY = "wss://old.example";
const NEW_RELAY = "wss://new.example";
const KEYS = { keyring: settingsKeyring("06".repeat(32)), previous: [] };

interface QueryOptions {
  enabled?: boolean;
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
}

const h = vi.hoisted(() => ({
  relays: ["wss://old.example"] as string[],
  nip65Relays: ["wss://old.example"] as string[],
  automaticSettingsSync: true,
  queryData: undefined as unknown,
  queryOptions: undefined as QueryOptions | undefined,
  publish: vi.fn(),
  relayQuery: vi.fn(),
  closedRelays: new Set<string>(),
  storeQuery: vi.fn(async () => [] as NostrEvent[]),
  records: [] as unknown[],
  dirtyListeners: new Set<(pubkey: string, buckets: readonly number[]) => void>(),
  keys: undefined as unknown,
  ensure: vi.fn(),
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: (relay: string) => ({
        // NRelay1.req's shape: EVENTs then EOSE, or an end with neither when
        // the relay CLOSED the REQ.
        async *req(filters: unknown, options: unknown) {
          if (h.closedRelays.has(relay)) return;
          const events = await h.relayQuery(relay, filters, options) as NostrEvent[];
          for (const event of events) yield ["EVENT", "sub", event] as const;
          yield ["EOSE", "sub"] as const;
        },
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
      automaticSettingsSync: h.automaticSettingsSync,
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
      signer: { nip44: { encrypt: vi.fn(), decrypt: vi.fn() } },
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

vi.mock("@/hooks/useDmConversationIndex", async () => {
  const lib = await import("@/lib/dmConversationIndex");
  return {
    dmConversationIndexBuckets: async () => Array.from(
      { length: lib.DM_CONVERSATION_INDEX_BUCKETS },
      (_, bucket) => lib.fitDmConversationIndexBucket(bucket, h.records as never),
    ),
    hydrateDmConversationIndexRecords: async () => undefined,
    recordDmConversationIndex: async () => false,
    subscribeDmConversationIndexChanges: (
      listener: (pubkey: string, buckets: readonly number[]) => void,
    ) => {
      h.dirtyListeners.add(listener);
      return () => h.dirtyListeners.delete(listener);
    },
  };
});

// These imports support the recorder exported from the same module. They are
// inert in this suite, so keep the sync-owner test independent of DM queries.
vi.mock("@/hooks/useDirectMessages", () => ({
  useDMConversations: () => ({ conversations: [], isLoading: false }),
}));
vi.mock("@/hooks/useDm17", () => ({
  useDm17Conversations: () => ({ conversations: [], isLoading: false }),
}));
vi.mock("@/hooks/useKnownDmPeers", () => ({
  useKnownDmPeers: () => ({ isKnown: () => false, isLoading: false }),
}));

import {
  DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS,
  DM_CONVERSATION_INDEX_RETRY_MS,
  useDmConversationIndexSync,
} from "@/hooks/useDmConversationIndexSync";
import { dmConversationIndexBucket } from "@/lib/dmConversationIndex";

function localRecord(seed: number) {
  return {
    key: seed.toString(16).padStart(64, "0"),
    latest: { createdAt: seed, id: (seed + 10_000).toString(16).padStart(64, "0") },
    mine: true,
  };
}

async function pull(view: { rerender: () => void }): Promise<void> {
  h.queryData = await h.queryOptions!.queryFn({ signal: new AbortController().signal });
  view.rerender();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function recordLocally(seed: number): number {
  const entry = localRecord(seed);
  h.records = [...h.records, entry];
  const bucket = dmConversationIndexBucket(entry.key);
  for (const listener of h.dirtyListeners) listener(SELF, [bucket]);
  return bucket;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.relays = [OLD_RELAY];
  h.nip65Relays = [OLD_RELAY];
  h.automaticSettingsSync = true;
  h.queryData = undefined;
  h.queryOptions = undefined;
  h.records = [];
  h.keys = KEYS;
  h.dirtyListeners.clear();
  h.closedRelays.clear();
  h.publish.mockReset().mockResolvedValue(undefined);
  h.relayQuery.mockReset().mockResolvedValue([]);
  h.storeQuery.mockClear();
  h.ensure.mockReset().mockRejectedValue(new Error("Settings sync has not been set up for this account"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DM index relay-set publication base", () => {
  it("uses an answered app relay when the account has no NIP-65 writer yet", async () => {
    h.nip65Relays = [];
    renderHook(() => useDmConversationIndexSync());
    await expect(h.queryOptions!.queryFn({ signal: new AbortController().signal }))
      .resolves.toEqual(expect.objectContaining({ publishRelays: [OLD_RELAY] }));
  });

  it("requires a declared NIP-65 write relay to answer", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [NEW_RELAY];
    h.closedRelays.add(NEW_RELAY);
    renderHook(() => useDmConversationIndexSync());
    await expect(h.queryOptions!.queryFn({ signal: new AbortController().signal }))
      .rejects.toThrow(/declared NIP-65 write relay/);
  });

  it("treats a relay that CLOSED the pull as unanswered, not as empty", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [OLD_RELAY, NEW_RELAY];
    h.closedRelays.add(NEW_RELAY);
    renderHook(() => useDmConversationIndexSync());
    await expect(h.queryOptions!.queryFn({ signal: new AbortController().signal }))
      .resolves.toEqual(expect.objectContaining({ publishRelays: [OLD_RELAY] }));
  });

  it("reads the eight derived buckets and the legacy shards", async () => {
    renderHook(() => useDmConversationIndexSync());
    await h.queryOptions!.queryFn({ signal: new AbortController().signal });
    const filters = h.relayQuery.mock.calls[0]![1];
    expect(filters).toEqual([
      expect.objectContaining({ authors: KEYS.keyring.dmConversations.map((doc) => doc.pubkey) }),
      expect.objectContaining({ authors: [SELF], "#t": ["armada-dm-conversations"] }),
    ]);
  });

  it("republishes a bucket the pulled head lacks, under that bucket's derived key", async () => {
    const bucket = dmConversationIndexBucket(localRecord(1).key);
    h.records = [localRecord(1)];
    const view = renderHook(() => useDmConversationIndexSync());
    await pull(view);

    expect(h.publish).toHaveBeenCalledOnce();
    const [, , event, relays] = h.publish.mock.calls[0]!;
    expect(relays).toEqual([OLD_RELAY]);
    expect(event).toMatchObject({
      pubkey: KEYS.keyring.dmConversations[bucket]!.pubkey,
      tags: [["d", KEYS.keyring.dmConversations[bucket]!.d]],
    });
    view.unmount();
  });

  it("debounces a local change into one publish of its bucket", async () => {
    const view = renderHook(() => useDmConversationIndexSync());
    await pull(view);
    await act(async () => {
      recordLocally(2);
      recordLocally(2);
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS);
    });
    expect(h.publish).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("retries a bucket whose delivery failed outright", async () => {
    h.publish.mockRejectedValueOnce(new Error("signer offline"));
    const view = renderHook(() => useDmConversationIndexSync());
    await pull(view);
    await act(async () => {
      recordLocally(3);
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS);
    });
    expect(h.publish).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_RETRY_MS);
    });
    expect(h.publish).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("publishes nothing when the account has not set up sync", async () => {
    h.keys = { keyring: null, previous: [] };
    h.records = [localRecord(4)];
    const view = renderHook(() => useDmConversationIndexSync());
    await pull(view);
    expect(h.ensure).toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not pull or publish while automatic settings sync is off", async () => {
    h.automaticSettingsSync = false;
    const view = renderHook(() => useDmConversationIndexSync());
    expect(h.queryOptions!.enabled).toBe(false);
    await act(async () => {
      recordLocally(5);
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS);
    });
    expect(h.publish).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not reuse an old pull after the relay set changes", async () => {
    const view = renderHook(() => useDmConversationIndexSync());
    await pull(view);
    h.relays = [NEW_RELAY];
    h.nip65Relays = [NEW_RELAY];
    view.rerender();
    await act(async () => {
      recordLocally(6);
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS);
    });
    expect(h.publish).not.toHaveBeenCalled();
    view.unmount();
  });
});

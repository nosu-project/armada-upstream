import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

const SELF = "f".repeat(64);
const OLD_RELAY = "wss://old.example";
const NEW_RELAY = "wss://new.example";

interface QueryOptions {
  enabled?: boolean;
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
}

const h = vi.hoisted(() => ({
  relays: ["wss://old.example"] as string[],
  nip65Relays: ["wss://old.example"] as string[],
  automaticSettingsSync: true,
  queryData: undefined as unknown,
  queryDataUpdatedAt: 0,
  queryFetchStatus: "idle" as "fetching" | "idle" | "paused",
  queryOptions: undefined as QueryOptions | undefined,
  refetch: vi.fn(),
  publish: vi.fn(),
  relayQuery: vi.fn(),
  storeQuery: vi.fn(async () => [] as NostrEvent[]),
  encrypt: vi.fn(async (_pubkey: string, plaintext: string) => `encrypted:${plaintext}`),
  decrypt: vi.fn(async (_pubkey: string, ciphertext: string) =>
    ciphertext.startsWith("encrypted:") ? ciphertext.slice("encrypted:".length) : ciphertext),
  hydrate: vi.fn(async (..._args: unknown[]) => undefined),
  needsPublish: vi.fn(async () => [] as number[]),
  shards: [] as unknown[],
  dirtyListeners: new Set<(pubkey: string, buckets: readonly number[]) => void>(),
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
    return {
      data: h.queryData,
      dataUpdatedAt: h.queryDataUpdatedAt,
      fetchStatus: h.queryFetchStatus,
      refetch: h.refetch,
    };
  },
}));

vi.mock("@/lib/verifyCache", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/verifyCache")>(),
  verifyEventOnce: () => true,
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
      signer: {
        nip44: {
          encrypt: h.encrypt,
          decrypt: h.decrypt,
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

vi.mock("@/hooks/useDmConversationIndex", () => ({
  dmConversationDeviceId: () => "test-device",
  hydrateDmConversationIndexShards: (...args: unknown[]) => h.hydrate(...args),
  loadOwnDmConversationIndexShards: async () => h.shards,
  ownDmConversationIndexNeedsPublish: () => h.needsPublish(),
  recordDmConversationIndex: async () => false,
  subscribeDmConversationIndexChanges: (
    listener: (pubkey: string, buckets: readonly number[]) => void,
  ) => {
    h.dirtyListeners.add(listener);
    return () => h.dirtyListeners.delete(listener);
  },
}));

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
  DM_CONVERSATION_INDEX_PULL_RETRY_MS,
  DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS,
  DM_CONVERSATION_INDEX_RETRY_MS,
  useDmConversationIndexSync,
} from "@/hooks/useDmConversationIndexSync";
import {
  DM_CONVERSATIONS_EVENT_KIND,
  DM_CONVERSATIONS_EVENT_TAG,
  dmConversationIndexBucket,
  dmConversationIndexDTag,
  serializeDmConversationIndexShard,
  type DmConversationIndexRecord,
  type DmConversationIndexShard,
} from "@/lib/dmConversationIndex";

function baseKey(relays: readonly string[], nip65Relays = relays): string {
  return `${SELF}\u0001${[...relays].sort().join("\u0000")}`
    + `\u0002${[...nip65Relays].sort().join("\u0000")}`;
}

function emptyPull(relays: readonly string[], nip65Relays = relays) {
  return {
    shards: [],
    heads: new Map(),
    unreadable: new Set(),
    baseKey: baseKey(relays, nip65Relays),
    publishRelays: [...relays],
    relayReads: new Map(relays.map((relay) => [relay, {
      heads: new Map(),
      unreadable: new Set(),
    }])),
    repairTargets: new Map(),
    departedRepairs: new Map(),
    repairPending: false,
  };
}

function localRecord(seed: number) {
  return {
    key: seed.toString(16).padStart(64, "0"),
    latest: {
      createdAt: seed,
      id: (seed + 10_000).toString(16).padStart(64, "0"),
    },
    mine: true,
  };
}

function setLocalRecords(records: DmConversationIndexRecord[]): DmConversationIndexShard {
  const bucket = dmConversationIndexBucket(records[0]!.key);
  if (records.some((entry) => dmConversationIndexBucket(entry.key) !== bucket)) {
    throw new Error("test records must share a bucket");
  }
  const shard = {
    version: 1,
    deviceId: "test-device",
    bucket,
    records,
  } satisfies DmConversationIndexShard;
  h.shards = [shard];
  return shard;
}

function eventForShard(
  shard: DmConversationIndexShard,
  idSeed: string,
  createdAt: number,
): NostrEvent {
  return {
    id: idSeed.repeat(64).slice(0, 64),
    pubkey: SELF,
    kind: DM_CONVERSATIONS_EVENT_KIND,
    created_at: createdAt,
    content: serializeDmConversationIndexShard(shard),
    tags: [
      ["d", dmConversationIndexDTag(shard.deviceId, shard.bucket)],
      ["t", DM_CONVERSATIONS_EVENT_TAG],
    ],
    sig: "1".repeat(128),
  };
}

function nextRecordInBucket(seed: number, bucket: number): DmConversationIndexRecord {
  let candidate = seed;
  while (dmConversationIndexBucket(localRecord(candidate).key) !== bucket) candidate++;
  return localRecord(candidate);
}

function changeLocalRecord(seed: number): number {
  const entry = localRecord(seed);
  const { bucket } = setLocalRecords([entry]);
  for (const listener of h.dirtyListeners) listener(SELF, [bucket]);
  return bucket;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  h.relays = [OLD_RELAY];
  h.nip65Relays = [OLD_RELAY];
  h.automaticSettingsSync = true;
  h.shards = [];
  h.dirtyListeners.clear();
  h.queryData = emptyPull(h.relays);
  h.queryDataUpdatedAt = 1;
  h.queryFetchStatus = "idle";
  h.queryOptions = undefined;
  h.refetch.mockReset().mockResolvedValue({ data: h.queryData });
  h.publish.mockReset().mockResolvedValue(undefined);
  h.relayQuery.mockReset().mockResolvedValue([]);
  h.storeQuery.mockReset().mockResolvedValue([]);
  h.encrypt.mockClear();
  h.decrypt.mockReset().mockImplementation(async (_pubkey: string, ciphertext: string) =>
    ciphertext.startsWith("encrypted:") ? ciphertext.slice("encrypted:".length) : ciphertext);
  h.hydrate.mockReset().mockResolvedValue(undefined);
  h.needsPublish.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DM index relay-set publication base", () => {
  it("uses an answered app relay when the account has no NIP-65 writer yet", async () => {
    h.relays = [OLD_RELAY];
    h.nip65Relays = [];
    h.queryData = undefined;
    renderHook(() => useDmConversationIndexSync());

    await expect(h.queryOptions!.queryFn({ signal: new AbortController().signal }))
      .resolves.toEqual(expect.objectContaining({ publishRelays: [OLD_RELAY] }));
  });

  it("requires a declared NIP-65 write relay to answer before the pull can publish", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [NEW_RELAY];
    h.queryData = undefined;
    h.relayQuery.mockImplementation(async (relay: string) => {
      if (relay === NEW_RELAY) throw new Error("offline");
      return [];
    });
    renderHook(() => useDmConversationIndexSync());

    await expect(h.queryOptions!.queryFn({ signal: new AbortController().signal }))
      .rejects.toThrow(/declared NIP-65 write relay/);
    expect(h.relayQuery).toHaveBeenCalledTimes(2);
  });

  it("targets only relays that participated in a partial but canonical pull", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [OLD_RELAY, NEW_RELAY];
    h.queryData = undefined;
    h.relayQuery.mockImplementation(async (relay: string) => {
      if (relay === NEW_RELAY) throw new Error("offline");
      return [];
    });
    const view = renderHook(() => useDmConversationIndexSync());
    h.queryData = await h.queryOptions!.queryFn({ signal: new AbortController().signal });
    view.rerender();
    await act(async () => Promise.resolve());

    await act(async () => {
      changeLocalRecord(3);
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS);
    });

    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({
      relays: [OLD_RELAY],
      inheritPendingTargets: false,
    }));
    view.unmount();
  });

  it("repairs a returning empty relay exactly, then stops after read-back", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [OLD_RELAY, NEW_RELAY];
    h.queryData = undefined;
    const ownShard = setLocalRecords([localRecord(30)]);
    const headA = eventForShard(ownShard, "a", 100);
    let headB: NostrEvent | undefined;
    let relayBOnline = false;
    h.relayQuery.mockImplementation(async (relay: string) => {
      if (relay === NEW_RELAY) {
        if (!relayBOnline) throw new Error("temporarily offline");
        return headB ? [headB] : [];
      }
      return [headA];
    });
    h.publish.mockImplementation(async (template: {
      kind: number;
      content: string;
      tags: string[][];
      created_at: number;
      relays: string[];
      onSigned?: (event: NostrEvent) => void;
    }) => {
      const event: NostrEvent = {
        id: "b".repeat(64),
        pubkey: SELF,
        kind: template.kind,
        content: template.content,
        tags: template.tags,
        created_at: template.created_at,
        sig: "2".repeat(128),
      };
      template.onSigned?.(event);
      if (template.relays.includes(NEW_RELAY)) headB = event;
    });
    const view = renderHook(() => useDmConversationIndexSync());

    const partial = await h.queryOptions!.queryFn({ signal: new AbortController().signal }) as {
      repairPending: boolean;
      repairTargets: Map<number, string[]>;
    };
    expect(partial.repairPending).toBe(true);
    expect(partial.repairTargets.size).toBe(0);
    h.queryData = partial;
    h.queryDataUpdatedAt++;
    view.rerender();
    await act(async () => Promise.resolve());
    expect(h.publish).not.toHaveBeenCalled();

    relayBOnline = true;
    let retryFinished = Promise.resolve<unknown>(undefined);
    h.refetch.mockImplementation(() => {
      h.queryFetchStatus = "fetching";
      view.rerender();
      retryFinished = h.queryOptions!.queryFn({ signal: new AbortController().signal })
        .then((data) => {
          h.queryData = data;
          h.queryDataUpdatedAt++;
          h.queryFetchStatus = "idle";
          view.rerender();
          return { data };
        });
      return retryFinished;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PULL_RETRY_MS);
      await retryFinished;
    });
    await act(async () => Promise.resolve());

    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({
      relays: [NEW_RELAY],
      inheritPendingTargets: false,
    }));
    const repaired = h.publish.mock.calls[0]![0] as { content: string };
    expect(repaired.content).toBe(`encrypted:${serializeDmConversationIndexShard(ownShard)}`);

    // EVENT acceptance is followed by one relay-local read-back. Once B shows
    // the exact head, repairPending clears and the idle hook stops polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PULL_RETRY_MS);
      await retryFinished;
    });
    await act(async () => Promise.resolve());
    expect(h.refetch).toHaveBeenCalledTimes(2);
    expect(h.publish).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PULL_RETRY_MS * 2);
    });
    expect(h.refetch).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("merges a returning relay's richer own shard before repairing the stale relay", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [OLD_RELAY, NEW_RELAY];
    h.queryData = undefined;
    const first = localRecord(40);
    const bucket = dmConversationIndexBucket(first.key);
    const second = nextRecordInBucket(41, bucket);
    const shardA = setLocalRecords([first]);
    const shardB = { ...shardA, records: [first, second] } satisfies DmConversationIndexShard;
    const headA = eventForShard(shardA, "c", 100);
    const headB = eventForShard(shardB, "d", 110);
    h.relayQuery.mockImplementation(async (relay: string) =>
      relay === NEW_RELAY ? [headB] : [headA]);
    h.hydrate.mockImplementation(async (_pubkey: unknown, value: unknown) => {
      const own = (value as DmConversationIndexShard[])
        .find((shard) => shard.deviceId === "test-device" && shard.bucket === bucket);
      if (own) h.shards = [own];
    });
    const view = renderHook(() => useDmConversationIndexSync());

    const pull = await h.queryOptions!.queryFn({ signal: new AbortController().signal }) as {
      repairPending: boolean;
      repairTargets: Map<number, string[]>;
    };
    expect(pull.repairPending).toBe(true);
    expect(pull.repairTargets.get(bucket)).toEqual([OLD_RELAY]);
    h.queryData = pull;
    h.queryDataUpdatedAt++;
    view.rerender();
    await act(async () => Promise.resolve());

    expect(h.publish).toHaveBeenCalledOnce();
    const published = h.publish.mock.calls[0]![0] as { content: string; relays: string[] };
    expect(published.relays).toEqual([OLD_RELAY]);
    const merged = JSON.parse(published.content.slice("encrypted:".length)) as DmConversationIndexShard;
    expect(merged.records.map((entry) => entry.key).sort())
      .toEqual([first.key, second.key].sort());
    view.unmount();
  });

  it("backfills a departed installation coordinate when an empty relay returns", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [OLD_RELAY, NEW_RELAY];
    h.queryData = undefined;
    h.shards = [];
    const entry = localRecord(60);
    const departed = {
      version: 1,
      deviceId: "departed-device",
      bucket: dmConversationIndexBucket(entry.key),
      records: [entry],
    } satisfies DmConversationIndexShard;
    const headA = eventForShard(departed, "7", 100);
    let headB: NostrEvent | undefined;
    let relayBOnline = false;
    h.relayQuery.mockImplementation(async (relay: string) => {
      if (relay === NEW_RELAY) {
        if (!relayBOnline) throw new Error("temporarily offline");
        return headB ? [headB] : [];
      }
      return [headA];
    });
    h.publish.mockImplementation(async (template: {
      kind: number;
      content: string;
      tags: string[][];
      created_at: number;
      relays: string[];
    }) => {
      if (!template.relays.includes(NEW_RELAY)) return;
      headB = {
        id: "8".repeat(64),
        pubkey: SELF,
        kind: template.kind,
        content: template.content,
        tags: template.tags,
        created_at: template.created_at,
        sig: "3".repeat(128),
      };
    });
    const view = renderHook(() => useDmConversationIndexSync());

    const partial = await h.queryOptions!.queryFn({ signal: new AbortController().signal }) as {
      repairPending: boolean;
      departedRepairs: Map<string, unknown>;
    };
    expect(partial.repairPending).toBe(true);
    expect(partial.departedRepairs.size).toBe(0);
    h.queryData = partial;
    h.queryDataUpdatedAt++;
    view.rerender();
    await act(async () => Promise.resolve());

    relayBOnline = true;
    let retryFinished = Promise.resolve<unknown>(undefined);
    h.refetch.mockImplementation(() => {
      h.queryFetchStatus = "fetching";
      view.rerender();
      retryFinished = h.queryOptions!.queryFn({ signal: new AbortController().signal })
        .then((data) => {
          h.queryData = data;
          h.queryDataUpdatedAt++;
          h.queryFetchStatus = "idle";
          view.rerender();
          return { data };
        });
      return retryFinished;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PULL_RETRY_MS);
      await retryFinished;
    });
    await act(async () => Promise.resolve());

    expect(h.publish).toHaveBeenCalledOnce();
    const published = h.publish.mock.calls[0]![0] as {
      content: string;
      tags: string[][];
      relays: string[];
    };
    expect(published.relays).toEqual([NEW_RELAY]);
    expect(published.tags).toContainEqual([
      "d",
      dmConversationIndexDTag(departed.deviceId, departed.bucket),
    ]);
    expect(published.content).toBe(`encrypted:${serializeDmConversationIndexShard(departed)}`);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PULL_RETRY_MS);
      await retryFinished;
    });
    await act(async () => Promise.resolve());
    expect(h.refetch).toHaveBeenCalledTimes(2);
    expect(h.publish).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PULL_RETRY_MS * 2);
    });
    expect(h.refetch).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("consolidates divergent departed-installation editions before repairing either relay", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [OLD_RELAY, NEW_RELAY];
    h.queryData = undefined;
    h.shards = [];
    const first = localRecord(70);
    const bucket = dmConversationIndexBucket(first.key);
    const second = nextRecordInBucket(71, bucket);
    const shardA = {
      version: 1,
      deviceId: "departed-device",
      bucket,
      records: [first],
    } satisfies DmConversationIndexShard;
    const shardB = { ...shardA, records: [second] } satisfies DmConversationIndexShard;
    h.relayQuery.mockImplementation(async (relay: string) => [
      relay === NEW_RELAY
        ? eventForShard(shardB, "1", 110)
        : eventForShard(shardA, "0", 100),
    ]);
    const view = renderHook(() => useDmConversationIndexSync());

    const pull = await h.queryOptions!.queryFn({ signal: new AbortController().signal }) as {
      departedRepairs: Map<string, { relays: string[] }>;
    };
    const identifier = dmConversationIndexDTag("departed-device", bucket);
    expect(new Set(pull.departedRepairs.get(identifier)?.relays))
      .toEqual(new Set([OLD_RELAY, NEW_RELAY]));
    h.queryData = pull;
    h.queryDataUpdatedAt++;
    view.rerender();
    await act(async () => Promise.resolve());

    expect(h.publish).toHaveBeenCalledOnce();
    const published = h.publish.mock.calls[0]![0] as {
      content: string;
      created_at: number;
      relays: string[];
    };
    expect(new Set(published.relays)).toEqual(new Set([OLD_RELAY, NEW_RELAY]));
    expect(published.created_at).toBeGreaterThan(110);
    const merged = JSON.parse(published.content.slice("encrypted:".length)) as DmConversationIndexShard;
    expect(merged.records.map((record) => record.key).sort())
      .toEqual([first.key, second.key].sort());
    view.unmount();
  });

  it("retries a cached-only unreadable departed head until decryption succeeds", async () => {
    h.relays = [OLD_RELAY];
    h.nip65Relays = [OLD_RELAY];
    h.queryData = undefined;
    h.shards = [];
    const first = localRecord(80);
    const bucket = dmConversationIndexBucket(first.key);
    const second = nextRecordInBucket(81, bucket);
    const relayShard = {
      version: 1,
      deviceId: "departed-device",
      bucket,
      records: [first],
    } satisfies DmConversationIndexShard;
    const cachedShard = {
      ...relayShard,
      records: [first, second],
    } satisfies DmConversationIndexShard;
    const relayHead = eventForShard(relayShard, "2", 100);
    const cachedHead = {
      ...eventForShard(cachedShard, "3", 200),
      content: "cached-ciphertext",
    };
    let cachedDecrypts = false;
    h.decrypt.mockImplementation(async (_pubkey: string, ciphertext: string) => {
      if (ciphertext === "cached-ciphertext") {
        if (!cachedDecrypts) throw new Error("remote signer temporarily denied");
        return serializeDmConversationIndexShard(cachedShard);
      }
      return ciphertext.startsWith("encrypted:")
        ? ciphertext.slice("encrypted:".length)
        : ciphertext;
    });
    h.relayQuery.mockResolvedValue([relayHead]);
    h.storeQuery.mockResolvedValue([cachedHead]);
    const view = renderHook(() => useDmConversationIndexSync());

    const firstPull = await h.queryOptions!.queryFn({ signal: new AbortController().signal }) as {
      repairPending: boolean;
      departedRepairs: Map<string, unknown>;
    };
    expect(firstPull.departedRepairs.size).toBe(0);
    expect(firstPull.repairPending).toBe(true);
    h.queryData = firstPull;
    h.queryDataUpdatedAt++;
    view.rerender();
    await act(async () => Promise.resolve());
    expect(h.publish).not.toHaveBeenCalled();

    cachedDecrypts = true;
    let retryFinished = Promise.resolve<unknown>(undefined);
    h.refetch.mockImplementation(() => {
      h.queryFetchStatus = "fetching";
      view.rerender();
      retryFinished = h.queryOptions!.queryFn({ signal: new AbortController().signal })
        .then((data) => {
          h.queryData = data;
          h.queryDataUpdatedAt++;
          h.queryFetchStatus = "idle";
          view.rerender();
          return { data };
        });
      return retryFinished;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PULL_RETRY_MS);
      await retryFinished;
    });
    await act(async () => Promise.resolve());

    expect(h.refetch).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    const published = h.publish.mock.calls[0]![0] as { content: string; relays: string[] };
    expect(published.relays).toEqual([OLD_RELAY]);
    const merged = JSON.parse(published.content.slice("encrypted:".length)) as DmConversationIndexShard;
    expect(merged.records.map((record) => record.key).sort())
      .toEqual([first.key, second.key].sort());
    view.unmount();
  });

  it("keeps a relay with an unreadable local head out of every write cohort", async () => {
    h.relays = [OLD_RELAY, NEW_RELAY];
    h.nip65Relays = [OLD_RELAY, NEW_RELAY];
    h.queryData = undefined;
    const first = localRecord(50);
    const bucket = dmConversationIndexBucket(first.key);
    const second = nextRecordInBucket(51, bucket);
    const shard = setLocalRecords([first]);
    const readableA = eventForShard(shard, "e", 200);
    const unreadableB = {
      ...eventForShard(shard, "f", 100),
      content: "unreadable",
    };
    h.decrypt.mockImplementation(async (_pubkey: string, ciphertext: string) => {
      if (ciphertext === "unreadable") throw new Error("signer denied");
      return ciphertext.startsWith("encrypted:")
        ? ciphertext.slice("encrypted:".length)
        : ciphertext;
    });
    h.relayQuery.mockImplementation(async (relay: string) =>
      relay === NEW_RELAY ? [unreadableB] : [readableA]);
    const view = renderHook(() => useDmConversationIndexSync());

    const pull = await h.queryOptions!.queryFn({ signal: new AbortController().signal }) as {
      publishRelays: string[];
      repairPending: boolean;
    };
    expect(pull.publishRelays).toEqual([OLD_RELAY]);
    expect(pull.repairPending).toBe(true);

    // A local edit after the read may publish to readable A, but must not let
    // aggregate A's newer valid head disguise B as a safe target.
    setLocalRecords([first, second]);
    h.needsPublish.mockResolvedValue([bucket]);
    h.queryData = pull;
    h.queryDataUpdatedAt++;
    view.rerender();
    await act(async () => Promise.resolve());

    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({
      relays: [OLD_RELAY],
    }));
    view.unmount();
  });

  it("invalidates the pull-before-publish latch when the relay set changes", async () => {
    const view = renderHook(() => useDmConversationIndexSync());
    await act(async () => Promise.resolve());

    h.relays = [NEW_RELAY];
    h.nip65Relays = [NEW_RELAY];
    // React Query can retain the prior key's data for a render. It must never
    // establish the new relay set's write base.
    h.queryData = emptyPull([OLD_RELAY]);
    view.rerender();
    await act(async () => {
      changeLocalRecord(1);
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS);
    });

    expect(h.publish).not.toHaveBeenCalled();
    view.unmount();
  });

  it("retries when onSigned ran but neither delivery nor durable queueing succeeded", async () => {
    h.publish.mockImplementation(async (template: { onSigned?: (event: NostrEvent) => void }) => {
      template.onSigned?.({
        id: "e".repeat(64),
        pubkey: SELF,
        kind: 30078,
        created_at: 100,
        content: "ciphertext",
        tags: [],
        sig: "1".repeat(128),
      });
      throw new Error("relay and outbox unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = renderHook(() => useDmConversationIndexSync());
    await act(async () => Promise.resolve());

    await act(async () => {
      changeLocalRecord(2);
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS);
    });
    expect(h.publish).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_RETRY_MS);
    });
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    view.unmount();
  });

  it("recovers a failed base pull and publishes local changes without Sync Now", async () => {
    h.queryData = undefined;
    h.relayQuery.mockRejectedValue(new Error("relay offline"));
    const view = renderHook(() => useDmConversationIndexSync());

    await expect(h.queryOptions!.queryFn({ signal: new AbortController().signal }))
      .rejects.toThrow(/No self-state relay completed/);
    const bucket = changeLocalRecord(6);
    h.needsPublish.mockResolvedValue([bucket]);
    expect(h.publish).not.toHaveBeenCalled();

    h.relayQuery.mockResolvedValue([]);
    let retryFinished = Promise.resolve<unknown>(undefined);
    h.refetch.mockImplementation(() => {
      retryFinished = h.queryOptions!.queryFn({ signal: new AbortController().signal })
        .then((data) => {
          h.queryData = data;
          view.rerender();
          return { data };
        });
      return retryFinished;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PULL_RETRY_MS);
      await retryFinished;
    });
    await act(async () => Promise.resolve());

    expect(h.refetch).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("does not retry or publish while automatic settings sync is off", async () => {
    h.automaticSettingsSync = false;
    h.queryData = undefined;
    const view = renderHook(() => useDmConversationIndexSync());

    expect(h.queryOptions?.enabled).toBe(false);
    changeLocalRecord(7);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DM_CONVERSATION_INDEX_PULL_RETRY_MS * 2
          + DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS,
      );
    });

    expect(h.refetch).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not retry without a canonical relay in the target set", async () => {
    h.relays = [OLD_RELAY];
    h.nip65Relays = [NEW_RELAY];
    h.queryData = undefined;
    const view = renderHook(() => useDmConversationIndexSync());

    expect(h.queryOptions?.enabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DM_CONVERSATION_INDEX_PULL_RETRY_MS * 2);
    });

    expect(h.refetch).not.toHaveBeenCalled();
    view.unmount();
  });
});

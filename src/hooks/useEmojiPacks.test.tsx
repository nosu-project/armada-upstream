/**
 * Regression tests for the kind-10030 emoji-list wipe bug class.
 *
 * The user's NIP-30 emoji list is a replaceable event that `useAddEmojiPack`
 * mutates by read-modify-write. A relay read that comes back empty for a
 * transient reason (cold pool, AUTH, a slow relay raced out) is
 * indistinguishable from "this account has no list" in a bare `query`, and
 * republishing a list rebuilt from that empty base replaces every emoji the
 * user has. `readEmojiList` guards this by (a) applying the local event store
 * as a floor and (b) using `req` so an EOSE — a relay actually reporting
 * end-of-stored-events — is the only thing that authorizes a from-scratch
 * list. See AGENTS.md "Never publish a user's Nostr lists without an explicit
 * user action."
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  emojiPackCoord,
  useAddEmojiPack,
  useHasEmojiPack,
  useRemoveEmojiPack,
} from "@/hooks/useEmojiPacks";

import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const SELF = "a".repeat(64);
const PACK_PK = "b".repeat(64);
const COORD = emojiPackCoord(PACK_PK, "mypack");
const OTHER_COORD = emojiPackCoord(PACK_PK, "other");

type ReqMsg = [string, string, NostrEvent?] | [string, string, string];

const h = vi.hoisted(() => ({
  req: vi.fn<(...args: unknown[]) => AsyncIterable<ReqMsg>>(),
  storeQuery: vi.fn<(...args: unknown[]) => Promise<NostrEvent[]>>(),
  publish: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  user: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { req: h.req } }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publish }),
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: h.storeQuery }),
}));

let evCounter = 0;
function listEvent(opts: { createdAt: number; tags?: string[][]; content?: string }): NostrEvent {
  return {
    id: `ev${++evCounter}`.padEnd(64, "0").slice(0, 64),
    pubkey: SELF,
    created_at: opts.createdAt,
    kind: 10030,
    tags: opts.tags ?? [],
    content: opts.content ?? "",
    sig: "f".repeat(128),
  };
}

/** A `req` stream that emits the given events and then EOSE (a conclusive read). */
function reqConclusive(events: NostrEvent[]): () => AsyncIterable<ReqMsg> {
  return () =>
    (async function* () {
      for (const ev of events) yield ["EVENT", "sub", ev] as ReqMsg;
      yield ["EOSE", "sub"] as ReqMsg;
    })();
}

/** A `req` stream that throws before any EOSE (an aborted / failed read). */
function reqFailed(): () => AsyncIterable<ReqMsg> {
  return () =>
    // eslint-disable-next-line require-yield -- throws before it can yield, on purpose
    (async function* () {
      throw new Error("relay offline");
    })();
}

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

/** The tags of the single published event. */
function publishedTags(): string[][] {
  const arg = h.publish.mock.calls[0][0] as { tags: string[][] };
  return arg.tags;
}

beforeEach(() => {
  localStorage.clear(); // the durable-palette guard reads armada:custom-emojis:<pk>
  h.req.mockReset();
  h.storeQuery.mockReset().mockResolvedValue([]);
  h.publish.mockReset().mockResolvedValue({
    id: "c".repeat(64),
    pubkey: SELF,
    created_at: 9999,
    sig: "s".repeat(128),
  });
  h.user = { pubkey: SELF };
});

describe("useAddEmojiPack (kind 10030 read-modify-write)", () => {
  function renderAdd(client?: QueryClient) {
    const w = client
      ? { client, wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ) }
      : makeWrapper();
    return renderHook(() => useAddEmojiPack(), { wrapper: w.wrapper }).result;
  }

  it("appends the new pack to the existing list rather than replacing it", async () => {
    h.req.mockImplementation(
      reqConclusive([listEvent({ createdAt: 100, tags: [["a", OTHER_COORD]] })]),
    );

    const result = renderAdd();
    await act(async () => {
      await result.current.mutateAsync({ pubkey: PACK_PK, identifier: "mypack" });
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    const tags = publishedTags();
    expect(tags).toContainEqual(["a", OTHER_COORD]);
    expect(tags).toContainEqual(["a", COORD]);
  });

  it("REFUSES to publish when the read failed and a list is known to exist (the wipe)", async () => {
    h.req.mockImplementation(reqFailed());
    const { client, wrapper } = makeWrapper();
    client.setQueryData(["emoji-pack-refs", SELF], [OTHER_COORD]);

    const result = renderHook(() => useAddEmojiPack(), { wrapper }).result;
    await act(async () => {
      await expect(
        result.current.mutateAsync({ pubkey: PACK_PK, identifier: "mypack" }),
      ).rejects.toThrow(/couldn't read/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("REFUSES to publish on an inconclusive read even when the caches look empty", async () => {
    // No EOSE ever arrived, so "no event" proves nothing — a from-scratch list
    // is not authorized regardless of what the caches (don't) hold.
    h.req.mockImplementation(reqFailed());

    const result = renderAdd();
    await act(async () => {
      await expect(
        result.current.mutateAsync({ pubkey: PACK_PK, identifier: "mypack" }),
      ).rejects.toThrow(/couldn't read/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("creates a fresh list only when a relay confirmed (EOSE) there is none", async () => {
    h.req.mockImplementation(reqConclusive([])); // EOSE, no events

    const result = renderAdd();
    await act(async () => {
      await result.current.mutateAsync({ pubkey: PACK_PK, identifier: "mypack" });
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    const arg = h.publish.mock.calls[0][0] as { kind: number; tags: string[][]; content: string };
    expect(arg.kind).toBe(10030);
    expect(arg.tags).toEqual([["a", COORD]]);
  });

  it("creates a fresh list on a single conclusive read (no second confirming re-read)", async () => {
    // The first add used to require a SECOND, identical read to also EOSE. The
    // replaceable batcher tends to collapse that immediate re-read into a
    // no-EOSE hang, which made adding your very first pack impossible. One
    // conclusive empty read with no durable evidence must be enough: even if a
    // second read would fail outright, the pack is still added.
    let call = 0;
    h.req.mockImplementation(() => {
      call += 1;
      return call === 1 ? reqConclusive([])() : reqFailed()();
    });

    const result = renderAdd();
    await act(async () => {
      await result.current.mutateAsync({ pubkey: PACK_PK, identifier: "mypack" });
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(publishedTags()).toEqual([["a", COORD]]);
  });

  it("REFUSES to create from an empty read when a durable palette exists (cold-reload wipe)", async () => {
    // localStorage is the reload-surviving record that this account HAS emojis;
    // the in-memory caches are empty on a cold load, so without this guard a
    // spurious conclusive-empty read would rebuild the list from scratch and
    // wipe every emoji. Even an EOSE'd empty read must back off here.
    localStorage.setItem(
      `armada:custom-emojis:${SELF}`,
      JSON.stringify([{ shortcode: "cat", url: "https://x/cat.png" }]),
    );
    h.req.mockImplementation(reqConclusive([]));

    const result = renderAdd();
    await act(async () => {
      await expect(
        result.current.mutateAsync({ pubkey: PACK_PK, identifier: "mypack" }),
      ).rejects.toThrow(/couldn't read/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("uses the cached list as a floor when the relay read fails (non-destructive append)", async () => {
    // Relay errors out, but the local store still holds the real list — the
    // append must build on that, not wipe it.
    h.req.mockImplementation(reqFailed());
    h.storeQuery.mockResolvedValue([listEvent({ createdAt: 100, tags: [["a", OTHER_COORD]] })]);

    const result = renderAdd();
    await act(async () => {
      await result.current.mutateAsync({ pubkey: PACK_PK, identifier: "mypack" });
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    const tags = publishedTags();
    expect(tags).toContainEqual(["a", OTHER_COORD]);
    expect(tags).toContainEqual(["a", COORD]);
  });

  it("carries the pack's relay hint onto the `a` tag", async () => {
    h.req.mockImplementation(reqConclusive([]));

    const result = renderAdd();
    await act(async () => {
      await result.current.mutateAsync({
        pubkey: PACK_PK,
        identifier: "mypack",
        relay: "wss://relay.example",
      });
    });

    expect(publishedTags()).toContainEqual(["a", COORD, "wss://relay.example"]);
  });

  it("is a no-op when the pack is already in the list", async () => {
    h.req.mockImplementation(reqConclusive([listEvent({ createdAt: 100, tags: [["a", COORD]] })]));

    const result = renderAdd();
    await act(async () => {
      await result.current.mutateAsync({ pubkey: PACK_PK, identifier: "mypack" });
    });

    expect(h.publish).not.toHaveBeenCalled();
  });

  it("takes the newest of the relay and store copies", async () => {
    // Relay echoes a stale list (only OTHER_COORD); the store holds a newer one
    // that also has a third pack. The newer copy must win so nothing reverts.
    const THIRD = emojiPackCoord(PACK_PK, "third");
    h.req.mockImplementation(
      reqConclusive([listEvent({ createdAt: 100, tags: [["a", OTHER_COORD]] })]),
    );
    h.storeQuery.mockResolvedValue([
      listEvent({ createdAt: 200, tags: [["a", OTHER_COORD], ["a", THIRD]] }),
    ]);

    const result = renderAdd();
    await act(async () => {
      await result.current.mutateAsync({ pubkey: PACK_PK, identifier: "mypack" });
    });

    const tags = publishedTags();
    expect(tags).toContainEqual(["a", OTHER_COORD]);
    expect(tags).toContainEqual(["a", THIRD]);
    expect(tags).toContainEqual(["a", COORD]);
  });
});

describe("useRemoveEmojiPack (kind 10030 read-modify-write)", () => {
  function renderRemove(client?: QueryClient) {
    const w = client
      ? { client, wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ) }
      : makeWrapper();
    return renderHook(() => useRemoveEmojiPack(), { wrapper: w.wrapper }).result;
  }

  it("strips only the target pack, preserving other refs and inline emojis", async () => {
    h.req.mockImplementation(
      reqConclusive([
        listEvent({
          createdAt: 100,
          tags: [["a", OTHER_COORD], ["a", COORD], ["emoji", "cat", "https://x/cat.png"]],
          content: "keep",
        }),
      ]),
    );

    const result = renderRemove();
    await act(async () => {
      await result.current.mutateAsync({ coord: COORD });
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    const arg = h.publish.mock.calls[0][0] as { tags: string[][]; content: string };
    expect(arg.tags).toContainEqual(["a", OTHER_COORD]);
    expect(arg.tags).toContainEqual(["emoji", "cat", "https://x/cat.png"]);
    expect(arg.tags).not.toContainEqual(["a", COORD]);
    expect(arg.content).toBe("keep");
  });

  it("REFUSES to publish when the read failed and a list is known to exist (the wipe)", async () => {
    h.req.mockImplementation(reqFailed());
    const { client, wrapper } = makeWrapper();
    client.setQueryData(["emoji-pack-refs", SELF], [COORD]);

    const result = renderHook(() => useRemoveEmojiPack(), { wrapper }).result;
    await act(async () => {
      await expect(result.current.mutateAsync({ coord: COORD })).rejects.toThrow(/couldn't read/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("REFUSES to publish on an inconclusive read even when the caches look empty", async () => {
    h.req.mockImplementation(reqFailed());

    const result = renderRemove();
    await act(async () => {
      await expect(result.current.mutateAsync({ coord: COORD })).rejects.toThrow(/couldn't read/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("is a silent no-op when a relay confirms there is no list", async () => {
    h.req.mockImplementation(reqConclusive([])); // EOSE, no events

    const result = renderRemove();
    await act(async () => {
      await result.current.mutateAsync({ coord: COORD });
    });

    expect(h.publish).not.toHaveBeenCalled();
  });

  it("is a no-op when the pack isn't in the list", async () => {
    h.req.mockImplementation(reqConclusive([listEvent({ createdAt: 100, tags: [["a", OTHER_COORD]] })]));

    const result = renderRemove();
    await act(async () => {
      await result.current.mutateAsync({ coord: COORD });
    });

    expect(h.publish).not.toHaveBeenCalled();
  });

  it("uses the cached list as a floor when the relay read fails (removes off the real list)", async () => {
    h.req.mockImplementation(reqFailed());
    h.storeQuery.mockResolvedValue([
      listEvent({ createdAt: 100, tags: [["a", OTHER_COORD], ["a", COORD]] }),
    ]);

    const result = renderRemove();
    await act(async () => {
      await result.current.mutateAsync({ coord: COORD });
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    const tags = publishedTags();
    expect(tags).toContainEqual(["a", OTHER_COORD]);
    expect(tags).not.toContainEqual(["a", COORD]);
  });

  it("can remove the last pack, publishing an empty ref list on a real read", async () => {
    h.req.mockImplementation(reqConclusive([listEvent({ createdAt: 100, tags: [["a", COORD]] })]));

    const result = renderRemove();
    await act(async () => {
      await result.current.mutateAsync({ coord: COORD });
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(publishedTags()).toEqual([]);
  });
});

describe("useHasEmojiPack", () => {
  it("reports true when the list references the pack, false otherwise", async () => {
    h.req.mockImplementation(reqConclusive([listEvent({ createdAt: 100, tags: [["a", COORD]] })]));
    const { wrapper } = makeWrapper();

    const has = renderHook(() => useHasEmojiPack(COORD), { wrapper }).result;
    await waitFor(() => expect(has.current).toBe(true));

    const hasnt = renderHook(() => useHasEmojiPack(OTHER_COORD), { wrapper }).result;
    await waitFor(() => expect(hasnt.current).toBe(false));
  });
});

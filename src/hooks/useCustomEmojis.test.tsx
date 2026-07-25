/**
 * Tests for the read side of the custom-emoji palette.
 *
 * `useCustomEmojis` resolves the user's kind-10030 list plus every kind-30030
 * pack it references, backed by a DURABLE per-user localStorage copy. The React
 * Query cache is wiped on every reload, so that durable floor is what stops the
 * picker re-deriving from a live two-hop race each load and blanking when the
 * race is lost. The rule: a read replaces the stored palette only when it
 * produces something (or proves the list genuinely empty); anything short keeps
 * the last durable palette.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCustomEmojis } from "@/hooks/useCustomEmojis";

import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const SELF = "a".repeat(64);
const PACK_PK = "b".repeat(64);
const PALETTE_KEY = `armada:custom-emojis:${SELF}`;

const h = vi.hoisted(() => ({
  query: vi.fn<(...args: unknown[]) => Promise<NostrEvent[]>>(),
  req: vi.fn<(...args: unknown[]) => AsyncIterable<unknown[]>>(),
  storeQuery: vi.fn<(...args: unknown[]) => Promise<NostrEvent[]>>(),
  user: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { query: h.query, req: h.req } }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: h.storeQuery }),
}));
vi.mock("@/buzz/useBuzzEmojiPalette", () => ({
  useBuzzEmojiPalette: () => [],
}));
vi.mock("@/hooks/useChatScope", () => ({
  useChatScope: () => undefined,
}));

let evCounter = 0;
function listEvent(opts: { createdAt: number; tags: string[][] }): NostrEvent {
  return {
    id: `ev${++evCounter}`.padEnd(64, "0").slice(0, 64),
    pubkey: SELF,
    created_at: opts.createdAt,
    kind: 10030,
    tags: opts.tags,
    content: "",
    sig: "f".repeat(128),
  };
}

function packEvent(opts: { createdAt: number; d: string; emojis: [string, string][] }): NostrEvent {
  return {
    id: `pk${++evCounter}`.padEnd(64, "0").slice(0, 64),
    pubkey: PACK_PK,
    created_at: opts.createdAt,
    kind: 30030,
    tags: [["d", opts.d], ...opts.emojis.map(([s, u]) => ["emoji", s, u])],
    content: "",
    sig: "f".repeat(128),
  };
}

const packRef = (d: string): string[] => ["a", `30030:${PACK_PK}:${d}`];

/** True when a filter set targets the pack (kind 30030) rather than the list. */
function isPackFilter(filters: unknown): boolean {
  const first = (filters as { kinds?: number[] }[])[0];
  return !!first?.kinds?.includes(30030);
}

/** The relay side of the 10030 list read (streams over `req`). */
function relayList(events: NostrEvent[], { eose = true }: { eose?: boolean } = {}) {
  h.req.mockImplementation(async function* () {
    for (const event of events) yield ["EVENT", "sub", event];
    if (eose) yield ["EOSE", "sub"];
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderEmojis() {
  return renderHook(() => useCustomEmojis(), { wrapper }).result;
}

function stored(): unknown {
  return JSON.parse(localStorage.getItem(PALETTE_KEY) ?? "null");
}

beforeEach(() => {
  localStorage.clear();
  h.query.mockReset().mockResolvedValue([]);
  h.storeQuery.mockReset().mockResolvedValue([]);
  relayList([]);
  h.user = { pubkey: SELF };
});

describe("useCustomEmojis", () => {
  it("resolves inline emoji tags and referenced packs, and persists them", async () => {
    relayList([
      listEvent({ createdAt: 100, tags: [["emoji", "wave", "https://e/wave.png"], packRef("mypack")] }),
    ]);
    h.query.mockImplementation(async (filters) =>
      isPackFilter(filters)
        ? [packEvent({ createdAt: 100, d: "mypack", emojis: [["cat", "https://e/cat.png"]] })]
        : [],
    );

    const result = renderEmojis();
    await waitFor(() => expect(result.current.emojis).toHaveLength(2));
    // Inline list emojis have no source pack; pack emojis carry theirs, which
    // is what the picker groups by and the reaction detail attributes.
    expect(result.current.emojis).toContainEqual({
      shortcode: "wave",
      url: "https://e/wave.png",
      packCoord: undefined,
      packName: undefined,
    });
    expect(result.current.emojis).toContainEqual({
      shortcode: "cat",
      url: "https://e/cat.png",
      packCoord: `30030:${PACK_PK}:mypack`,
      packName: "mypack",
    });
    // The resolved palette is written to the durable store.
    await waitFor(() => expect(stored()).toHaveLength(2));
  });

  it("takes the newest 10030 across relay and store", async () => {
    relayList([listEvent({ createdAt: 100, tags: [["emoji", "old", "https://e/old.png"]] })]);
    h.storeQuery.mockImplementation(async (filters) =>
      isPackFilter(filters)
        ? []
        : [listEvent({ createdAt: 200, tags: [["emoji", "new", "https://e/new.png"]] })],
    );

    const result = renderEmojis();
    await waitFor(() =>
      expect(result.current.emojis).toContainEqual({ shortcode: "new", url: "https://e/new.png" }),
    );
    expect(result.current.emojis).not.toContainEqual({ shortcode: "old", url: "https://e/old.png" });
  });

  it("merges packs newest-per-address across relay and store", async () => {
    relayList([listEvent({ createdAt: 100, tags: [packRef("mypack")] })]);
    h.query.mockImplementation(async (filters) =>
      isPackFilter(filters)
        ? [packEvent({ createdAt: 100, d: "mypack", emojis: [["v", "https://e/old.png"]] })]
        : [],
    );
    h.storeQuery.mockImplementation(async (filters) =>
      isPackFilter(filters)
        ? [packEvent({ createdAt: 200, d: "mypack", emojis: [["v", "https://e/new.png"]] })]
        : [],
    );

    const result = renderEmojis();
    await waitFor(() =>
      expect(result.current.emojis).toContainEqual(
        expect.objectContaining({ shortcode: "v", url: "https://e/new.png" }),
      ),
    );
    expect(result.current.emojis).not.toContainEqual(
      expect.objectContaining({ shortcode: "v", url: "https://e/old.png" }),
    );
  });
});

/**
 * The durable floor. Every case here is a reload (React Query cache empty) with
 * a palette already persisted from a previous session — the picker must show it
 * and a short read must not wipe it.
 */
describe("useCustomEmojis — the persisted palette survives a bad read", () => {
  const KEPT = { shortcode: "kept", url: "https://e/kept.png" };

  beforeEach(() => {
    localStorage.setItem(PALETTE_KEY, JSON.stringify([KEPT]));
  });

  it("shows the persisted palette immediately, before any read resolves", () => {
    relayList([], { eose: false }); // never resolves
    const result = renderEmojis();
    expect(result.current.emojis).toEqual([KEPT]);
  });

  it("keeps it when the list read never completes", async () => {
    relayList([], { eose: false });
    const result = renderEmojis();
    await waitFor(() => expect(h.req).toHaveBeenCalled());
    await waitFor(() => expect(result.current.emojis).toEqual([KEPT]));
    expect(stored()).toEqual([KEPT]);
  });

  it("keeps it when a referenced pack fails to resolve", async () => {
    // The 10030 resolves and still references the pack, but no read returns it.
    relayList([listEvent({ createdAt: 100, tags: [packRef("mypack")] })]);
    const result = renderEmojis();
    await waitFor(() => expect(h.req).toHaveBeenCalled());
    await waitFor(() => expect(result.current.emojis).toEqual([KEPT]));
    expect(stored()).toEqual([KEPT]);
  });

  it("replaces it once the packs actually resolve", async () => {
    relayList([listEvent({ createdAt: 200, tags: [packRef("mypack")] })]);
    h.query.mockImplementation(async (filters) =>
      isPackFilter(filters)
        ? [packEvent({ createdAt: 200, d: "mypack", emojis: [["v", "https://e/v.png"]] })]
        : [],
    );

    const resolved = {
      shortcode: "v",
      url: "https://e/v.png",
      packCoord: `30030:${PACK_PK}:mypack`,
      packName: "mypack",
    };

    const result = renderEmojis();
    await waitFor(() => expect(result.current.emojis).toEqual([resolved]));
    expect(stored()).toEqual([resolved]);
  });

  it("clears it when the list is genuinely empty (a real removal)", async () => {
    // The list resolves with no inline emojis and no pack refs: really empty.
    relayList([listEvent({ createdAt: 300, tags: [] })]);
    const result = renderEmojis();
    await waitFor(() => expect(result.current.emojis).toEqual([]));
    expect(stored()).toEqual([]);
  });
});

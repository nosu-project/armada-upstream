/**
 * Tests for the read side of the custom-emoji list.
 *
 * `useCustomEmojis` resolves the user's kind-10030 list plus every kind-30030
 * pack it references. NostrSync invalidates this query on every incoming
 * 10030, so a read that came back short would otherwise replace a resolved
 * list with `[]`. Both the list read and the pack reads apply the local event
 * store as a floor and take the newest copy, so a relay miss or a stale echo
 * is non-destructive.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCustomEmojis } from "@/hooks/useCustomEmojis";

import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const SELF = "a".repeat(64);
const PACK_PK = "b".repeat(64);

const h = vi.hoisted(() => ({
  query: vi.fn<(...args: unknown[]) => Promise<NostrEvent[]>>(),
  storeQuery: vi.fn<(...args: unknown[]) => Promise<NostrEvent[]>>(),
  user: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { query: h.query } }),
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

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderEmojis() {
  return renderHook(() => useCustomEmojis(), { wrapper }).result;
}

beforeEach(() => {
  h.query.mockReset().mockResolvedValue([]);
  h.storeQuery.mockReset().mockResolvedValue([]);
  h.user = { pubkey: SELF };
});

describe("useCustomEmojis", () => {
  it("resolves inline emoji tags and referenced packs from the relay", async () => {
    h.query.mockImplementation(async (filters) =>
      isPackFilter(filters)
        ? [packEvent({ createdAt: 100, d: "mypack", emojis: [["cat", "https://e/cat.png"]] })]
        : [listEvent({ createdAt: 100, tags: [["emoji", "wave", "https://e/wave.png"], packRef("mypack")] })],
    );

    const result = renderEmojis();
    await waitFor(() => expect(result.current.emojis).toHaveLength(2));
    expect(result.current.emojis).toContainEqual({ shortcode: "wave", url: "https://e/wave.png" });
    expect(result.current.emojis).toContainEqual({ shortcode: "cat", url: "https://e/cat.png" });
  });

  it("falls back to the local store when the relay list read is empty", async () => {
    // Relay returns nothing for the 10030; the store still holds it. Returning
    // [] here would blank the palette on the next NostrSync invalidation.
    h.storeQuery.mockImplementation(async (filters) =>
      isPackFilter(filters)
        ? []
        : [listEvent({ createdAt: 100, tags: [["emoji", "wave", "https://e/wave.png"]] })],
    );

    const result = renderEmojis();
    await waitFor(() =>
      expect(result.current.emojis).toContainEqual({ shortcode: "wave", url: "https://e/wave.png" }),
    );
  });

  it("takes the newest 10030 across relay and store (a stale relay echo cannot win)", async () => {
    h.query.mockImplementation(async (filters) =>
      isPackFilter(filters)
        ? []
        : [listEvent({ createdAt: 100, tags: [["emoji", "old", "https://e/old.png"]] })],
    );
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
    h.query.mockImplementation(async (filters) =>
      isPackFilter(filters)
        ? [packEvent({ createdAt: 100, d: "mypack", emojis: [["v", "https://e/old.png"]] })]
        : [listEvent({ createdAt: 100, tags: [packRef("mypack")] })],
    );
    h.storeQuery.mockImplementation(async (filters) =>
      isPackFilter(filters)
        ? [packEvent({ createdAt: 200, d: "mypack", emojis: [["v", "https://e/new.png"]] })]
        : [],
    );

    const result = renderEmojis();
    await waitFor(() =>
      expect(result.current.emojis).toContainEqual({ shortcode: "v", url: "https://e/new.png" }),
    );
    expect(result.current.emojis).not.toContainEqual({ shortcode: "v", url: "https://e/old.png" });
  });
});

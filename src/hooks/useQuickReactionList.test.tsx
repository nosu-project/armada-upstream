/**
 * The kind-10077 quick-reaction list is replaceable, so a publish replaces it
 * everywhere. It must only ever build on the version the user was looking at,
 * and only after a relay has answered (AGENTS.md, the list-publish rule).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  QuickReactionsChangedError,
  usePublishQuickReactions,
  useQuickReactionList,
  useQuickReactions,
} from "@/hooks/useQuickReactionList";

import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const SELF = "a".repeat(64);

const h = vi.hoisted(() => ({
  wire: vi.fn<() => Promise<{ events: NostrEvent[]; answered: string[] }>>(),
  stored: [] as NostrEvent[],
  publish: vi.fn<(t: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: SELF } }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: {
      useAppRelays: true,
      appRelays: ["wss://app.example/"],
      useUserRelays: false,
      relayMetadata: { relays: [], updatedAt: 0 },
    },
  }),
}));
vi.mock("@/hooks/useEventStore", () => {
  const store = Promise.resolve({ query: async () => h.stored });
  return { useEventStore: () => store };
});
vi.mock("@/hooks/useNostrPublish", () => ({ useNostrPublish: () => ({ mutateAsync: h.publish }) }));
vi.mock("@/lib/nip65", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nip65")>()),
  queryExplicitRelaysWithStatus: async () => {
    const { events, answered } = await h.wire();
    return { events, answered, failed: [] };
  },
}));

let n = 0;
function list(tags: string[][], created_at = 1000): NostrEvent {
  return {
    id: `list${++n}`.padEnd(64, "0"),
    pubkey: SELF,
    created_at,
    kind: 10077,
    tags,
    content: "",
    sig: "f".repeat(128),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function render() {
  return renderHook(() => ({ list: useQuickReactionList(), publish: usePublishQuickReactions() }), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
  h.stored = [];
  h.wire.mockReset();
  h.publish.mockReset().mockImplementation(async (t) => t);
});

describe("useQuickReactionList", () => {
  it("reads the stored list in order", async () => {
    h.stored = [list([["reaction", "🔥"], ["reaction", ":cat:", "https://e.example/cat.png"]])];
    const view = render();
    await waitFor(() => expect(view.result.current.list.isFetched).toBe(true));
    expect(view.result.current.list.reactions).toEqual([
      { key: "🔥" },
      { key: ":cat:", url: "https://e.example/cat.png" },
    ]);
  });

  it("puts the list ahead of the most-used in the row", async () => {
    h.stored = [list([["reaction", "🐸"]])];
    const view = renderHook(() => useQuickReactions(SELF, 3), { wrapper });
    await waitFor(() => expect(view.result.current[0]).toEqual({ key: "🐸", pinned: true }));
    expect(view.result.current.map((s) => s.key)).toEqual(["🐸", "👍", "❤️"]);
  });
});

describe("usePublishQuickReactions", () => {
  it("replaces the reactions and keeps the list's other tags", async () => {
    const prev = list([["reaction", "🔥"], ["x-other", "kept"]]);
    h.stored = [prev];
    h.wire.mockResolvedValue({ events: [prev], answered: ["wss://app.example/"] });
    const view = render();
    await waitFor(() => expect(view.result.current.list.isFetched).toBe(true));

    await act(() => view.result.current.publish.mutateAsync({ reactions: [{ key: "🙏" }, { key: "🔥" }], basis: prev.id }));

    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 10077,
      tags: [["x-other", "kept"], ["reaction", "🙏"], ["reaction", "🔥"]],
      created_at: expect.any(Number),
      relays: ["wss://app.example/"],
    }));
  });

  it("refuses when no relay answered the read", async () => {
    h.wire.mockResolvedValue({ events: [], answered: [] });
    const view = render();
    await waitFor(() => expect(view.result.current.list.isFetched).toBe(true));

    await expect(view.result.current.publish.mutateAsync({ reactions: [{ key: "🙏" }], basis: null }))
      .rejects.toThrow(/Nothing was changed/);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("refuses when the relays hold a newer list than the one the user edited", async () => {
    const shown = list([["reaction", "🔥"]], 1000);
    const newer = list([["reaction", "🐸"]], 2000);
    h.stored = [shown];
    h.wire.mockResolvedValue({ events: [newer], answered: ["wss://app.example/"] });
    const view = render();
    await waitFor(() => expect(view.result.current.list.isFetched).toBe(true));

    await expect(view.result.current.publish.mutateAsync({ reactions: [{ key: "🙏" }], basis: shown.id }))
      .rejects.toBeInstanceOf(QuickReactionsChangedError);
    expect(h.publish).not.toHaveBeenCalled();
    // The row now shows what the relays hold.
    await waitFor(() => expect(view.result.current.list.reactions).toEqual([{ key: "🐸" }]));
  });

  it("refuses to create a list when the user was shown one that the read missed", async () => {
    const shown = list([["reaction", "🔥"]]);
    h.wire.mockResolvedValue({ events: [], answered: ["wss://app.example/"] });
    const view = render();
    await waitFor(() => expect(view.result.current.list.isFetched).toBe(true));

    await expect(view.result.current.publish.mutateAsync({ reactions: [], basis: shown.id }))
      .rejects.toBeInstanceOf(QuickReactionsChangedError);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("creates the first list on an answered read with nothing in it", async () => {
    h.wire.mockResolvedValue({ events: [], answered: ["wss://app.example/"] });
    const view = render();
    await waitFor(() => expect(view.result.current.list.isFetched).toBe(true));

    await act(() => view.result.current.publish.mutateAsync({ reactions: [{ key: "🙏" }], basis: null }));
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ tags: [["reaction", "🙏"]], content: "" }));
  });
});

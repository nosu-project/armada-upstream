import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const SELF = "a".repeat(64);
const FOLLOWED = "b".repeat(64);
const h = vi.hoisted(() => ({
  query: vi.fn<() => Promise<NostrEvent[]>>(),
  storeQuery: vi.fn(async () => [] as NostrEvent[]),
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      query: h.query,
      relay: () => ({ query: h.query }),
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: SELF } }),
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({
    query: h.storeQuery,
    event: async () => {},
  }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: {
      useAppRelays: true,
      appRelays: ["wss://state.example"],
      useUserRelays: false,
      relayMetadata: { relays: [], updatedAt: 0 },
    },
  }),
}));
vi.mock("@/hooks/useCacheFirstSeed", () => ({ useCacheFirstSeed: () => {} }));

import { useFollowList } from "@/hooks/useFollowList";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  h.query.mockReset();
  h.storeQuery.mockClear();
});

describe("useFollowList authority", () => {
  it("does not authorize an empty set while the wire read is pending", async () => {
    let finish!: (events: NostrEvent[]) => void;
    h.query.mockImplementation(() => new Promise<NostrEvent[]>((resolve) => { finish = resolve; }));
    const view = renderHook(() => useFollowList(), { wrapper });

    expect(view.result.current.data).toBeUndefined();
    await waitFor(() => expect(h.query).toHaveBeenCalled());
    await act(async () => { finish([]); });
    await waitFor(() => expect(view.result.current.data).toMatchObject({
      pubkeys: [],
      wireReady: true,
    }));
  });

  it("does not turn a failed wire read into an authoritative empty set", async () => {
    h.query.mockRejectedValue(new Error("offline"));
    const view = renderHook(() => useFollowList(), { wrapper });

    await waitFor(() => expect(view.result.current.data).toBeDefined());
    expect(view.result.current.data).toMatchObject({ pubkeys: [], wireReady: false });
  });

  it("keeps a local follow seed additive when every wire relay fails", async () => {
    h.query.mockRejectedValue(new Error("offline"));
    h.storeQuery.mockResolvedValue([{
      id: "c".repeat(64),
      pubkey: SELF,
      created_at: 10,
      kind: 3,
      tags: [["p", FOLLOWED]],
      content: "",
      sig: "d".repeat(128),
    }]);
    const view = renderHook(() => useFollowList(), { wrapper });

    await waitFor(() => expect(view.result.current.data?.pubkeys).toEqual([FOLLOWED]));
    expect(view.result.current.data?.wireReady).toBe(false);
  });
});

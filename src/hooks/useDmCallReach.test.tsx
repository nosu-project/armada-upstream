import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useDmCallReach } from "./useDmCallReach";

import type { ReactNode } from "react";

const SELF = "a".repeat(64);
const PEER = "b".repeat(64);
const OTHER = "c".repeat(64);

type Ev = { kind: number; created_at: number; tags: string[][] };
const kind3 = (created_at: number, ...follows: string[]): Ev => ({
  kind: 3,
  created_at,
  tags: follows.map((p) => ["p", p]),
});

const h = vi.hoisted(() => ({
  // What the local store holds, by kind.
  stored: [] as Array<{ kind: number; created_at: number; tags: string[][] }>,
  // The network's answer for the peer's kind 3 (a rejection = failed read).
  netQuery: vi.fn(async (): Promise<unknown[]> => []),
  storeEvent: vi.fn(async () => undefined),
  count: vi.fn(async () => 0),
  synced: true,
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: SELF } }) }));
vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: { query: h.netQuery } }) }));
const store = {
  query: async (filters: Array<{ kinds: number[] }>) =>
    h.stored.filter((e) => filters.some((f) => f.kinds.includes(e.kind))),
  event: h.storeEvent,
};
const storePromise = Promise.resolve(store);
vi.mock("@/hooks/useEventStore", () => ({ useEventStore: () => storePromise }));
vi.mock("@/lib/nip17/dm17Store", () => ({ countUnreadDm17Messages: h.count }));
vi.mock("@/lib/dmSynced", () => ({ isDmSynced: () => h.synced }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useDmCallReach", () => {
  beforeEach(() => {
    h.stored = [];
    h.netQuery.mockReset().mockResolvedValue([]);
    h.storeEvent.mockReset().mockResolvedValue(undefined);
    h.count.mockReset().mockResolvedValue(0);
    h.synced = true;
  });

  it("warns when a follow list of theirs omits us and they have never written", async () => {
    h.netQuery.mockResolvedValue([kind3(10, OTHER)]);
    const { result } = renderHook(() => useDmCallReach(PEER, false), { wrapper });
    await waitFor(() => expect(result.current).toBe("unlikely"));
    // Their messages in OUR 1:1, counted from the start of time.
    expect(h.count).toHaveBeenCalledWith(SELF, [PEER], -1, expect.anything());
  });

  it("does not warn off a follow list it could not read", async () => {
    // The pool timed out / every relay failed: nothing was read at all.
    h.netQuery.mockRejectedValue(new Error("timeout"));
    const { result } = renderHook(() => useDmCallReach(PEER, false), { wrapper });
    await waitFor(() => expect(h.netQuery).toHaveBeenCalled());
    await waitFor(() => expect(h.count).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current).toBe("unknown");
  });

  it("treats an empty follow-list read as unknown, not as not following", async () => {
    // A cold pool answers [] — indistinguishable from "they have no kind 3".
    const { result } = renderHook(() => useDmCallReach(PEER, false), { wrapper });
    await waitFor(() => expect(h.netQuery).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current).toBe("unknown");
  });

  it("lets a newer network copy override a stale stored list", async () => {
    h.stored = [kind3(10, OTHER)];
    const fresh = kind3(20, SELF);
    h.netQuery.mockResolvedValue([fresh]);
    const { result } = renderHook(() => useDmCallReach(PEER, false), { wrapper });
    await waitFor(() => expect(result.current).toBe("likely"));
    expect(h.storeEvent).toHaveBeenCalledWith(fresh);
  });

  it("expects a ring when a stored list follows us, without waiting on the network", async () => {
    h.stored = [kind3(10, SELF)];
    const { result } = renderHook(() => useDmCallReach(PEER, false), { wrapper });
    await waitFor(() => expect(result.current).toBe("likely"));
    expect(h.netQuery).not.toHaveBeenCalled();
  });

  it("expects a ring when they have written to us over NIP-17", async () => {
    h.netQuery.mockResolvedValue([kind3(10)]);
    h.count.mockResolvedValue(3);
    const { result } = renderHook(() => useDmCallReach(PEER, false), { wrapper });
    await waitFor(() => expect(result.current).toBe("likely"));
  });

  it("expects a ring when they have written to us over kind 4", async () => {
    h.netQuery.mockResolvedValue([kind3(10)]);
    h.stored = [{ kind: 4, created_at: 5, tags: [["p", SELF]] }];
    const { result } = renderHook(() => useDmCallReach(PEER, false), { wrapper });
    await waitFor(() => expect(result.current).toBe("likely"));
  });

  it("stays unknown until this device's first DM sync has completed", async () => {
    h.synced = false;
    h.netQuery.mockResolvedValue([kind3(10, OTHER)]);
    const { result } = renderHook(() => useDmCallReach(PEER, false), { wrapper });
    await waitFor(() => expect(h.netQuery).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current).toBe("unknown");
    // An empty unsynced store is not asked: its zero would be a false answer.
    expect(h.count).not.toHaveBeenCalled();
  });

  it("takes a message already on screen without asking the store", () => {
    const { result } = renderHook(() => useDmCallReach(PEER, true), { wrapper });
    expect(result.current).toBe("likely");
    expect(h.count).not.toHaveBeenCalled();
  });

  it("has nothing to say about calling ourselves", () => {
    const { result } = renderHook(() => useDmCallReach(SELF, false), { wrapper });
    expect(result.current).toBe("unknown");
  });
});

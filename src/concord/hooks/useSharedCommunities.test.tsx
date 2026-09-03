/**
 * The crossing SHAPE of the "mutual servers" read, not its fold correctness.
 *
 * `useSharedCommunities` folds each joined community's Guestbook Plane from the
 * store — one `queryPlane` per community, and on the native builds one
 * `queryPlane` is one bridge crossing plus one turn of the store's global lock
 * (see `NativeArmadaDB.ts` and its own tests). Two properties matter for the
 * lag this hook contributes on a profile open, and neither is about the fold:
 *
 *  - the read is O(communities) — one crossing per membership, unavoidable
 *    since each community is its own tenant and can't be merged into one query;
 *  - the crossings must OVERLAP rather than run back-to-back, because a
 *    sequential `await` in the loop pays each community's bridge+lock latency
 *    in series, which is the worst shape on Android.
 *
 * The guestbook fold is mocked to a fixed "everyone is joined" so the test is
 * only ever measuring the crossings; the fold itself is covered elsewhere.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  /** N community entries the viewer belongs to. */
  entries: [] as Array<{ community_id: string }>,
  /** Every `queryPlane` crossing, in the order it was ISSUED. */
  calls: [] as string[],
  /** Peak number of `queryPlane` calls in flight at once. */
  peak: 0,
  inFlight: 0,
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "viewer" } }),
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useLiveCommunities: () => h.entries,
}));
vi.mock("@/concord/lib/communityList", () => ({
  // The entry IS the community for this test; the crossing is what we measure.
  rehydrateCommunity: (entry: { community_id: string }) => ({
    idHex: entry.community_id,
    name: entry.community_id,
  }),
}));
vi.mock("@/concord/lib/guestbook", () => ({
  openGuestbookOpened: (stored: unknown) => stored,
  snapshotAuthorities: () => undefined,
  // Everyone the caller asks about is joined, so every read counts a community.
  coalesceGuestbook: () => ({ get: () => ({ state: "join" }) }),
}));
vi.mock("@/concord/lib/rumorStore", () => ({
  queryPlane: async (idHex: string) => {
    h.calls.push(idHex);
    h.inFlight++;
    h.peak = Math.max(h.peak, h.inFlight);
    // A real crossing does not settle synchronously; the gap is what lets a
    // sequential loop show as peak-of-one and a concurrent one as peak-of-N.
    await new Promise((resolve) => setTimeout(resolve, 1));
    h.inFlight--;
    return [];
  },
}));

const { useSharedCommunities } = await import("./useSharedCommunities");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function communities(n: number): void {
  h.entries = Array.from({ length: n }, (_, i) => ({ community_id: `c${i}` }));
}

describe("useSharedCommunities crossing shape", () => {
  beforeEach(() => {
    h.entries = [];
    h.calls = [];
    h.peak = 0;
    h.inFlight = 0;
  });

  it("issues exactly one guestbook crossing per joined community", async () => {
    communities(12);

    const { result } = renderHook(() => useSharedCommunities("someone-else"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // O(communities): the fan-out factor test 2 in NativeArmadaDB.test.ts
    // measures abstractly is literally the membership count here.
    expect(h.calls).toHaveLength(12);
    expect(new Set(h.calls).size).toBe(12);
    expect(result.current.data).toHaveLength(12);
  });

  it("overlaps the crossings instead of paying each one's latency in series", async () => {
    communities(12);

    const { result } = renderHook(() => useSharedCommunities("someone-else"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // A sequential `await` in the loop caps this at 1 — each crossing's
    // bridge+lock latency then adds rather than overlaps. Concurrent issue
    // puts all N in flight at once.
    expect(h.peak).toBe(12);
  });
});

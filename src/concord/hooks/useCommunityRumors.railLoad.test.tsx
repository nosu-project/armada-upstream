/**
 * The always-mounted `ServerRail` mounts one unread probe PER joined community,
 * and each probe's `useConcordUnread` mounts one {@link useCommunityRumors}.
 * That hook USED to carry a `refetchInterval` backstop, so N communities meant
 * N independent periodic full-store scans on N unaligned phases, firing whatever
 * screen the user was on — a recurring store load linear in membership, which is
 * why random frame hitches were a power-user problem and a non-problem for a new
 * user.
 *
 * The interval is gone (the wire bus is the complete in-process live path; see
 * the hook's own comment and rumorStore.test.ts's ring guarantee). This suite
 * drives the REAL hook, one instance per community exactly as the rail does, and
 * confirms the fix and guards it:
 *
 *  - a community is still read ONCE at mount (the first, unavoidable scan);
 *  - no amount of elapsed wall-clock adds a single further read — the RECURRING
 *    load is now zero for a new user and a power user alike. Re-introducing any
 *    `refetchInterval` on this hook fails the second and third tests.
 *
 * The live path (a `c2:` bus ring → delta re-read) is deliberately NOT exercised
 * here: this isolates the interval so "reads that happen with nothing arriving"
 * is exactly what it counts.
 */

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  /** One entry per store read, tagged with the community it scanned. */
  reads: [] as string[],
}));

vi.mock("@/concord/lib/rumorStore", () => ({
  // The real seam the rail's interval drives. Each call is one bridge crossing
  // on native; here it is one recorded read so the COUNT is what we assert.
  queryRumorsByChannel: vi.fn(async (communityIdHex: string) => {
    h.reads.push(communityIdHex);
    return new Map();
  }),
}));

// The live path (bus rings) is not what this test measures — it isolates the
// interval backstop — so the subscription is a no-op that never fires.
vi.mock("@/wire/useWireScopes", () => ({
  useWireScopes: () => {},
}));

const { useCommunityRumors } = await import("./useCommunityRumors");

// ── Harness ──────────────────────────────────────────────────────────────────

const CHANNELS = ["chan-1", "chan-2", "chan-3"];

/** One rail probe: exactly the `useCommunityRumors` mount `useConcordUnread` makes. */
function Probe({ id }: { id: string }): null {
  useCommunityRumors(id, CHANNELS);
  return null;
}

/** The rail: one probe per joined community, all under one shared QueryClient. */
function Rail({ communityIds }: { communityIds: string[] }): ReactNode {
  return <>{communityIds.map((id) => <Probe key={id} id={id} />)}</>;
}

function communityIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `community-${String(i).padStart(2, "0")}`);
}

function mount(ids: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Rail communityIds={ids} />
    </QueryClientProvider>,
  );
}

/**
 * A generous span of idle wall-clock — far past the 2-minute interval the hook
 * used to carry, and past every other rail poll period — during which NOTHING
 * arrives on the wire. Any read that lands in this window is an interval firing.
 */
const IDLE_SPAN_MS = 10 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  h.reads = [];
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("rail store load is one read per community, not a recurring poll", () => {
  it("reads each mounted community exactly once at mount", async () => {
    mount(communityIds(8));
    // Let the mounted queries' queryFns settle.
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(h.reads).toHaveLength(8);
    // One per community, not one shared read: each is its own tenant/query.
    expect(new Set(h.reads).size).toBe(8);
  });

  it("adds no further read as idle time passes — the recurring load is zero", async () => {
    mount(communityIds(8));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(h.reads).toHaveLength(8); // the initial scans, and the last of them

    // Ten minutes of idle wall-clock with nothing on the wire. With the old
    // backstop this added 8 reads every 2 minutes; now it adds none. A
    // re-introduced `refetchInterval` on the hook fails right here.
    await act(() => vi.advanceTimersByTimeAsync(IDLE_SPAN_MS));
    expect(h.reads).toHaveLength(8);
  });

  it("charges a power user the same recurring load as a new user: none", async () => {
    // A new user in one community. Everything past the mount scan is recurring.
    const newUser = mount(communityIds(1));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const newUserMount = h.reads.length; // 1 mount scan
    await act(() => vi.advanceTimersByTimeAsync(IDLE_SPAN_MS));
    const newUserRecurring = h.reads.length - newUserMount; // 0
    newUser.unmount();

    h.reads = [];

    // A power user in sixteen.
    const powerUser = mount(communityIds(16));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const powerUserMount = h.reads.length; // 16 mount scans
    await act(() => vi.advanceTimersByTimeAsync(IDLE_SPAN_MS));
    const powerUserRecurring = h.reads.length - powerUserMount; // 0
    powerUser.unmount();

    // The mount cost is still O(N) — unavoidable, each community's first read —
    // but it is paid ONCE, on open. The RECURRING cost, the source of the
    // power-user hitches, is zero on both. That equality is the whole fix.
    expect(newUserMount).toBe(1);
    expect(powerUserMount).toBe(16);
    expect(newUserRecurring).toBe(0);
    expect(powerUserRecurring).toBe(0);
  });
});

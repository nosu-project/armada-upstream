/**
 * Warm-up render churn under the post-login SyncGate.
 *
 * A fresh login mounts the full-screen SyncGate overlay and, UNDERNEATH it, the
 * whole app shell — including the always-mounted `ServerRail`, which stands up
 * one `useConcordUnread` → {@link useCommunityRumors} per joined community. The
 * warm-up then decrypts every community's newest channel pages into the store,
 * ringing `c2:<channel>` on the wire bus per committed burst. Each ring made
 * every mounted `useCommunityRumors` delta-read and `setQueryData`, re-rendering
 * the occluded rail — a render storm nobody can see, since the overlay covers
 * it. A Firefox profile of exactly this window showed ~1.2s of 100–200ms
 * LongTasks dominated by React reconciliation, not crypto.
 *
 * The fix is central, in the wire bus (`setWireGateHold`, driven by
 * `syncGateState`): while the overlay is up the bus HOLDS the re-read doorbells
 * and delivers them as one coalesced batch when it lifts — so every occluded
 * subscriber goes quiet, not just the ones that read the gate flag. This suite
 * drives the REAL hook and the REAL bus (only the store read is a counting
 * stub), one instance per community exactly as the rail does, and pins both
 * halves through that real path:
 *
 *  - while the overlay is up, warm-up bursts add ZERO delta reads and ZERO
 *    re-renders — the churn is gone;
 *  - when it lifts, each community is re-read exactly ONCE (the coalesced
 *    catch-up), O(N) paid once rather than O(bursts × N) throughout.
 *
 * The control test keeps the gate down and shows the storm the hold removes:
 * every burst re-reads and re-renders every community. (The bus's per-kind
 * behaviour — doorbells held, in-hand-work scopes passed through — is unit-
 * tested in `src/wire/bus.gateHold.test.ts`.)
 */

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  /** One entry per store read, tagged with the community it scanned. */
  reads: [] as string[],
  /** Bumped per read so every delta carries genuinely new content (else React
   *  Query's structural sharing would dedupe it and hide a real re-render). */
  seq: 0,
}));

vi.mock("@/concord/lib/rumorStore", () => ({
  queryRumorsByChannel: vi.fn(async (communityIdHex: string, channelIds: string[]) => {
    h.reads.push(communityIdHex);
    const marker = ++h.seq;
    return new Map(channelIds.map((id) => [id, [{ id: `${communityIdHex}:${id}:${marker}` }]]));
  }),
}));

const { useCommunityRumors } = await import("./useCommunityRumors");
const { emitWireScopes, resetWireBus } = await import("@/wire/bus");
const { setSyncGateActive, _resetSyncGateStateForTests } = await import("@/components/syncGateState");

// ── Harness ──────────────────────────────────────────────────────────────────

/** Total re-renders across every mounted probe, the render-churn signal. */
let renders = 0;

/** Distinct channels per community, so a burst that rings community i's
 *  channels matches only community i's probe (as the real store does). */
function channelsOf(id: string): string[] {
  return [`${id}-a`, `${id}-b`];
}

function Probe({ id }: { id: string }): null {
  useCommunityRumors(id, channelsOf(id));
  renders++;
  return null;
}

function communityIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `community-${String(i).padStart(2, "0")}`);
}

function mount(ids: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      {ids.map((id) => <Probe key={id} id={id} />) as ReactNode}
    </QueryClientProvider>,
  );
}

/** Advance past the bus's 50ms flush window and settle the async reads it kicks. */
async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

/** One warm-up burst: ring every community's channels, then flush the bus. */
async function warmupBurst(ids: string[]): Promise<void> {
  await act(async () => {
    emitWireScopes(ids.flatMap((id) => channelsOf(id).map((c) => `c2:${c}`)));
    await vi.advanceTimersByTimeAsync(100);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.reads = [];
  h.seq = 0;
  renders = 0;
  resetWireBus();
  _resetSyncGateStateForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetWireBus();
  _resetSyncGateStateForTests();
});

// ── Tests ────────────────────────────────────────────────────────────────────

const N = 12;
const BURSTS = 30;

describe("warm-up render churn under the SyncGate", () => {
  it("suppresses per-burst reads and re-renders while the overlay is up", async () => {
    setSyncGateActive(true); // the overlay is covering the app
    mount(communityIds(N));
    await tick(); // let the initial per-community mount scans settle

    const readsAtMount = h.reads.length; // N unavoidable first scans
    const rendersAtMount = renders;
    expect(readsAtMount).toBe(N);

    // The warm-up streams in behind the overlay.
    for (let i = 0; i < BURSTS; i++) await warmupBurst(communityIds(N));

    // The whole point: nothing was read and nothing re-rendered — the churn the
    // profile caught (bursts × N) is gone while it is invisible.
    expect(h.reads.length).toBe(readsAtMount);
    expect(renders).toBe(rendersAtMount);

    // The overlay lifts: fold the missed writes in with ONE read per community.
    setSyncGateActive(false);
    await tick();

    expect(h.reads.length).toBe(readsAtMount + N); // exactly one catch-up each
    // And the catch-up render is O(N) paid once, not O(bursts × N).
    expect(renders - rendersAtMount).toBeLessThanOrEqual(3 * N);
  });

  it("control: with no overlay, every burst re-reads and re-renders every community", async () => {
    // Gate down (the ordinary in-app case): the live path runs as before.
    mount(communityIds(N));
    await tick();

    const readsAtMount = h.reads.length;
    const rendersAtMount = renders;
    expect(readsAtMount).toBe(N);

    for (let i = 0; i < BURSTS; i++) await warmupBurst(communityIds(N));

    // Each burst delta-reads all N and re-renders them — the storm the guard
    // above removes. Reads are deterministic (one per community per burst);
    // renders scale with the same product.
    expect(h.reads.length).toBe(readsAtMount + BURSTS * N);
    expect(renders - rendersAtMount).toBeGreaterThanOrEqual(BURSTS * N);
  });
});

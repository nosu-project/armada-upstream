/**
 * Tests for ControlPlaneSync's sweep scheduling — kicks the global sweep as
 * soon as membership lists load, and re-kicks (rate-limited) after
 * stream-key registration waves. The NIP-42 auth hold lives inside planeSync.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToHex } from "@/concord/lib/derive";
import type { Community } from "@/concord/lib/types";

import { ControlPlaneSync } from "./ControlPlaneSync";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  syncSpy: vi.fn(async () => ({ concordTouched: new Set() })),
  entries: [] as unknown[],
  communityListData: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityList: () => ({ data: h.communityListData }),
}));
vi.mock("@/concord/lib/communityList", () => ({
  liveEntries: () => h.entries,
  rehydrateCommunity: (e: unknown) => e,
}));
vi.mock("@/lib/controlPlaneSync", () => ({
  syncControlPlane: (...args: unknown[]) => h.syncSpy(...(args as [])),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function communityOf(fill: number): Community {
  const root = new Uint8Array(32).fill(fill);
  const id = new Uint8Array(32).fill(fill + 1);
  return {
    id,
    idHex: bytesToHex(id),
    owner: "0".repeat(64),
    ownerSalt: new Uint8Array(32),
    root,
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: root }],
    privateChannels: [],
    relays: ["wss://relay-a.test"],
    name: "test",
  } as Community;
}

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ControlPlaneSync />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  h.syncSpy.mockClear();
  h.entries = [];
  h.communityListData = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ControlPlaneSync — global sweep scheduling", () => {
  it("kicks the sweep off as soon as the membership lists load", async () => {
    h.entries = [communityOf(70)];
    h.communityListData = { event: null, list: { entries: [] } };

    mount();
    await act(() => vi.advanceTimersByTimeAsync(100));

    // No component-level auth gating: planeSync holds the actual REQs until
    // the stream keys can authenticate, for every caller at once.
    expect(h.syncSpy).toHaveBeenCalledTimes(1);
  });

  it("never sweeps with no memberships at all", async () => {
    mount();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(h.syncSpy).not.toHaveBeenCalled();
  });
});

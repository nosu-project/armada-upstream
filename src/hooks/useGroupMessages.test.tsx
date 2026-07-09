/**
 * Regression tests for the NIP-29 timeline's wire hydration — "messages don't
 * appear in channels as they come in".
 *
 * Post-wire architecture: the hook holds NO sockets. The wire writes every
 * incoming event to the shared IndexedDB store and rings the bus; the hook
 * re-reads the store. Moderator deletions (kind-5 by another pubkey) are
 * honored on read.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { emitWireScopes, resetWireBus } from "@/wire/bus";

import { useGroupMessages } from "./useGroupMessages";

import type { NostrEvent } from "@nostrify/nostrify";

// ── Module mocks ─────────────────────────────────────────────────────────────

const OTHER = "a".repeat(64);
const RELAY = "wss://test.relay";

const h = vi.hoisted(() => ({
  store: { events: [] as unknown[] },
  relayEvents: [] as unknown[],
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () =>
    Promise.resolve({
      query: async (
        filters: Array<{ kinds?: number[]; "#h"?: string[]; limit?: number }>,
      ) => {
        const events = h.store.events as NostrEvent[];
        const out: NostrEvent[] = [];
        for (const f of filters) {
          for (const ev of events) {
            if (f.kinds && !f.kinds.includes(ev.kind)) continue;
            if (f["#h"] && !ev.tags.some(([n, v]) => n === "h" && f["#h"]!.includes(v))) continue;
            out.push(ev);
          }
        }
        return out;
      },
    }),
}));
vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({
        query: async () => h.relayEvents as NostrEvent[],
      }),
    },
  }),
}));
vi.mock("@/hooks/useTimelineSnapshot", () => ({
  useTimelineSnapshotWriter: () => {},
}));

afterEach(() => resetWireBus());

// ── Fixtures ─────────────────────────────────────────────────────────────────

let eventSeq = 0;
function msg(group: string, opts: { kind?: number; created_at?: number; etag?: string } = {}): NostrEvent {
  const tags = [["h", group]];
  if (opts.etag) tags.push(["e", opts.etag]);
  return {
    id: `${eventSeq++}`.padStart(64, "2"),
    kind: opts.kind ?? 9,
    pubkey: OTHER,
    created_at: opts.created_at ?? Math.floor(Date.now() / 1000),
    content: "hello",
    tags,
    sig: "",
  };
}

function setup() {
  h.store.events = [];
  h.relayEvents = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useGroupMessages (wire hydration)", () => {
  it("hydrates the timeline from the store", async () => {
    const { wrapper } = setup();
    const a = msg("g1", { created_at: 100 });
    const b = msg("g1", { created_at: 200 });
    h.store.events.push(b, a);

    const { result } = renderHook(() => useGroupMessages(RELAY, "g1"), { wrapper });

    await waitFor(() => expect(result.current.data?.length).toBe(2));
    expect(result.current.data?.map((e) => e.id)).toEqual([a.id, b.id]); // oldest-first
  });

  it("renders a new message when the wire rings the bus (no socket in the hook)", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useGroupMessages(RELAY, "g1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The wire ingests into the store, then announces.
    const incoming = msg("g1");
    h.store.events.push(incoming);
    emitWireScopes(["nip29:g1"]);

    await waitFor(() => expect(result.current.data?.some((e) => e.id === incoming.id)).toBe(true));
  });

  it("hides messages referenced by a kind-5 delete (moderator deletes included)", async () => {
    const { wrapper } = setup();
    const victim = msg("g1", { created_at: 100 });
    const keeper = msg("g1", { created_at: 200 });
    h.store.events.push(victim, keeper, msg("g1", { kind: 5, etag: victim.id }));

    const { result } = renderHook(() => useGroupMessages(RELAY, "g1"), { wrapper });

    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(result.current.data?.[0].id).toBe(keeper.id);
  });

  it("keeps optimistic sends painted across store re-reads", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useGroupMessages(RELAY, "g1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const mine = msg("g1");
    result.current.insertOptimistic(mine);
    await waitFor(() => expect(result.current.data?.some((e) => e.id === mine.id)).toBe(true));
    expect(result.current.status[mine.id]).toBe("pending");

    // A wire announcement re-reads the store; the optimistic message (not yet
    // in the store) must survive the fold.
    emitWireScopes(["nip29:g1"]);
    await new Promise((r) => setTimeout(r, 150));
    await waitFor(() => expect(result.current.data?.some((e) => e.id === mine.id)).toBe(true));
  });

  it("does not paint the previous channel's messages when switching channels on the same relay", async () => {
    const { wrapper } = setup();
    const a = msg("g1", { created_at: 100 });
    h.store.events.push(a);

    const { result, rerender } = renderHook(
      ({ group }: { group: string }) => useGroupMessages(RELAY, group),
      { wrapper, initialProps: { group: "g1" } },
    );
    await waitFor(() => expect(result.current.data?.map((e) => e.id)).toEqual([a.id]));

    // Switch to an empty channel on the SAME relay: the outgoing channel's
    // message must NOT linger (regression: placeholderData kept prev per-relay).
    rerender({ group: "g2" });
    expect(result.current.data?.some((e) => e.id === a.id) ?? false).toBe(false);

    // …and it must STAY gone on subsequent re-renders while g2's first read is
    // still pending. (Regression: an effect-updated ref re-admitted the old
    // channel's data through `placeholderData` one render after the switch —
    // the inline placeholder closure defeats TanStack's memoization, so any
    // re-render re-invokes it with the previous query's data, and by then the
    // ref already pointed at the new room.)
    rerender({ group: "g2" });
    expect(result.current.data?.some((e) => e.id === a.id) ?? false).toBe(false);

    // Eventually g2's own (empty) read settles.
    await waitFor(() => expect(result.current.data?.some((e) => e.id === a.id)).toBe(false));
  });
});

/**
 * Regression tests for the message-plane → unread-plane bridge — "messages
 * sync into the open channel but the sidebar badge / other devices' unread
 * state never updates" (no react-query cache update on the unread key).
 *
 * The live subscription and the background refresh in useGroupMessages used to
 * write only `["nip29","messages",…]`; the unread snapshot
 * `["nip29","unread",…]` relied entirely on its own second subscription. These
 * tests pin the fix: everything useGroupMessages ingests is fanned into the
 * unread caches too (idempotently), so badges stay correct even if the unread
 * hook's own tail is on a dead socket.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { useGroupMessages } from "./useGroupMessages";

import type { NostrEvent } from "@nostrify/nostrify";

// ── Module mocks ─────────────────────────────────────────────────────────────

const USER = "f".repeat(64);
const OTHER = "a".repeat(64);
const RELAY = "wss://test.relay";

const h = vi.hoisted(() => ({ pool: undefined as unknown }));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: h.pool }),
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: async () => [], event: async () => {} }),
}));
vi.mock("@/hooks/useNativeNotifications", () => ({
  isNativeRuntime: () => false,
}));
vi.mock("@/hooks/useTimelineSnapshot", () => ({
  useTimelineSnapshotWriter: () => {},
}));

// ── Fake relay ───────────────────────────────────────────────────────────────

interface Filter {
  kinds?: number[];
  "#h"?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

class FakeRelay {
  events: NostrEvent[] = [];
  private listeners = new Set<(msg: unknown[]) => void>();

  private match(f: Filter): NostrEvent[] {
    let evs = this.events.filter(
      (ev) =>
        (!f.kinds || f.kinds.includes(ev.kind)) &&
        (!f["#h"] || ev.tags.some(([n, v]) => n === "h" && f["#h"]!.includes(v))) &&
        (f.since === undefined || ev.created_at >= f.since) &&
        (f.until === undefined || ev.created_at <= f.until),
    );
    evs = [...evs].sort((a, b) => b.created_at - a.created_at);
    if (f.limit !== undefined) evs = evs.slice(0, f.limit);
    return evs;
  }

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    const out = new Map<string, NostrEvent>();
    for (const f of filters) for (const ev of this.match(f)) out.set(ev.id, ev);
    return [...out.values()];
  }

  async *req(_filters: Filter[], opts?: { signal?: AbortSignal }): AsyncGenerator<unknown> {
    const queue: unknown[][] = [];
    let notify: (() => void) | undefined;
    const listener = (msg: unknown[]) => {
      queue.push(msg);
      notify?.();
    };
    this.listeners.add(listener);
    try {
      while (!opts?.signal?.aborted) {
        while (queue.length > 0) yield queue.shift()!;
        await new Promise<void>((resolve) => {
          notify = resolve;
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        notify = undefined;
      }
    } finally {
      this.listeners.delete(listener);
    }
  }

  emit(event: NostrEvent): void {
    for (const l of this.listeners) l(["EVENT", "sub", event]);
  }

  async event(): Promise<void> {}
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let eventSeq = 0;
function msg(group: string, opts: { pubkey?: string; created_at?: number } = {}): NostrEvent {
  return {
    id: `${eventSeq++}`.padStart(64, "1"),
    kind: 9,
    pubkey: opts.pubkey ?? OTHER,
    created_at: opts.created_at ?? Math.floor(Date.now() / 1000),
    content: "hello",
    tags: [["h", group]],
    sig: "",
  };
}

function setup() {
  const relay = new FakeRelay();
  h.pool = { relay: () => relay };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { relay, queryClient, wrapper };
}

const unreadKey = ["nip29", "unread", RELAY, "g1", USER] as const;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useGroupMessages unread bridge", () => {
  it("fans live-subscription messages into the unread badge caches", async () => {
    const { relay, queryClient, wrapper } = setup();
    // The badge hook is mounted elsewhere (rail/sidebar): its cache entry exists.
    queryClient.setQueryData<NostrEvent[]>([...unreadKey], []);

    const { result } = renderHook(() => useGroupMessages(RELAY, "g1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const event = msg("g1");
    relay.emit(event);

    // The timeline gets it…
    await waitFor(() =>
      expect(result.current.data?.some((e) => e.id === event.id)).toBe(true),
    );
    // …and so does the unread cache (this was the missing invalidation).
    await waitFor(() => {
      const unread = queryClient.getQueryData<NostrEvent[]>([...unreadKey]);
      expect(unread?.some((e) => e.id === event.id)).toBe(true);
    });
  });

  it("fans background-refresh pages into the unread badge caches (dead-tail healing)", async () => {
    const { relay, queryClient, wrapper } = setup();
    queryClient.setQueryData<NostrEvent[]>([...unreadKey], []);

    // Message already on the relay before the channel opens — the tail never
    // replays it, only the fetch path sees it.
    const event = msg("g1", { created_at: Math.floor(Date.now() / 1000) - 3600 });
    relay.events.push(event);

    const { result } = renderHook(() => useGroupMessages(RELAY, "g1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await waitFor(() => {
      const unread = queryClient.getQueryData<NostrEvent[]>([...unreadKey]);
      expect(unread?.some((e) => e.id === event.id)).toBe(true);
    });
  });
});

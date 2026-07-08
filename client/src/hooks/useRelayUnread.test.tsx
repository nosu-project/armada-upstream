/**
 * Regression tests for the NIP-29 unread/badge pipeline — "messages sync but
 * channels never light up / new messages don't appear until a refocus".
 *
 * The old implementation kept live-tail events in per-instance component state
 * (`useState`), so:
 *   - badge state evaporated on every remount / dependency change;
 *   - the five instances of the hook (server rail ×3, sidebar, OS badge) each
 *     had their own private copy;
 *   - nothing bridged incoming messages into the channel timeline caches, so
 *     the "chat plane" of a community only synced for the one open channel.
 *
 * These tests pin the fixed behavior: all activity lives in the shared query
 * cache and live-tail events fan into both the unread and timeline planes.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { useRelayUnread } from "./useRelayUnread";

import type { NostrEvent } from "@nostrify/nostrify";

// ── Module mocks ─────────────────────────────────────────────────────────────

const USER = "f".repeat(64);
const OTHER = "a".repeat(64);
const RELAY = "wss://test.relay";

const h = vi.hoisted(() => ({
  pool: undefined as unknown,
  readState: {} as Record<string, number>,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: h.pool }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: USER } }),
}));
vi.mock("@/hooks/useMutes", () => ({
  useMutes: () => ({ isChannelMuted: () => false }),
}));
vi.mock("@/hooks/useReadState", () => ({
  channelReadKey: (relayUrl: string, groupId: string) => `${relayUrl}::${groupId}`,
  useReadState: () => ({ readState: h.readState }),
}));

// ── Fake relay ───────────────────────────────────────────────────────────────

interface Filter {
  kinds?: number[];
  "#h"?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

/**
 * In-memory relay honoring kinds/#h/since/until/limit, with a pushable live
 * `req` stream (`emit` delivers to every open subscription).
 */
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

  /** Deliver a live event to every open subscription. */
  emit(event: NostrEvent): void {
    for (const l of this.listeners) l(["EVENT", "sub", event]);
  }

  async event(): Promise<void> {}
}

function makePool(relays: Record<string, FakeRelay>) {
  return { relay: (url: string) => relays[url] };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let eventSeq = 0;
function msg(group: string, opts: { pubkey?: string; created_at?: number; ptag?: string } = {}): NostrEvent {
  const tags = [["h", group]];
  if (opts.ptag) tags.push(["p", opts.ptag]);
  return {
    id: `${eventSeq++}`.padStart(64, "0"),
    kind: 9,
    pubkey: opts.pubkey ?? OTHER,
    created_at: opts.created_at ?? Math.floor(Date.now() / 1000),
    content: "hello",
    tags,
    sig: "",
  };
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function setup(relay = new FakeRelay()) {
  h.pool = makePool({ [RELAY]: relay });
  h.readState = {};
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return { relay, queryClient };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useRelayUnread", () => {
  it("lights the badge from the snapshot query for unseen history", async () => {
    const { relay, queryClient } = setup();
    relay.events.push(msg("g1"));

    const { result } = renderHook(() => useRelayUnread(RELAY, ["g1", "g2"]), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.anyUnread).toBe(true));
    expect(result.current.byGroup["g1"]).toBeDefined();
    expect(result.current.byGroup["g2"]).toBeUndefined();
  });

  it("lights the badge from a live-tail event", async () => {
    const { relay, queryClient } = setup();

    const { result } = renderHook(() => useRelayUnread(RELAY, ["g1"]), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current).not.toBeUndefined());

    relay.emit(msg("g1", { ptag: USER }));

    await waitFor(() => expect(result.current.anyUnread).toBe(true));
    expect(result.current.byGroup["g1"].mention).toBe(true);
  });

  it("keeps live-tail activity across a remount (query cache, not component state)", async () => {
    const { relay, queryClient } = setup();

    const first = renderHook(() => useRelayUnread(RELAY, ["g1"]), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(first.result.current).not.toBeUndefined());

    // Delivered ONLY over the live tail — the relay's stored history stays
    // empty, so a refetch alone can never resurface this event.
    relay.emit(msg("g1"));
    await waitFor(() => expect(first.result.current.anyUnread).toBe(true));
    first.unmount();

    // A fresh instance (e.g. the sidebar re-rendering, or another rail icon)
    // must still see the unread state without the event being re-delivered.
    const second = renderHook(() => useRelayUnread(RELAY, ["g1"]), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(second.result.current.anyUnread).toBe(true));
  });

  it("fans live-tail messages into the channel's timeline cache (chat-plane sync)", async () => {
    const { relay, queryClient } = setup();
    // The channel has been opened before: its timeline cache entry exists.
    queryClient.setQueryData<NostrEvent[]>(["nip29", "messages", RELAY, "g1"], []);

    renderHook(() => useRelayUnread(RELAY, ["g1"]), { wrapper: wrapper(queryClient) });
    // Give the tail a beat to open, then deliver.
    await waitFor(() => expect(relay).toBeDefined());
    const event = msg("g1");
    relay.emit(event);

    await waitFor(() => {
      const timeline = queryClient.getQueryData<NostrEvent[]>(["nip29", "messages", RELAY, "g1"]);
      expect(timeline?.some((e) => e.id === event.id)).toBe(true);
    });
  });

  it("never counts self-authored messages as unread", async () => {
    const { relay, queryClient } = setup();
    relay.events.push(msg("g1", { pubkey: USER }));

    const { result } = renderHook(() => useRelayUnread(RELAY, ["g1"]), {
      wrapper: wrapper(queryClient),
    });

    relay.emit(msg("g1", { pubkey: USER }));
    // Settle the snapshot query, then confirm nothing lit.
    await waitFor(() =>
      expect(queryClient.getQueryState(["nip29", "unread", RELAY, "g1", USER])?.status).toBe("success"),
    );
    expect(result.current.anyUnread).toBe(false);
  });

  it("respects read-state: messages at or before last-read don't count", async () => {
    const { relay, queryClient } = setup();
    const ts = Math.floor(Date.now() / 1000);
    relay.events.push(msg("g1", { created_at: ts }));
    h.readState = { [`${RELAY}::g1`]: ts };

    const { result } = renderHook(() => useRelayUnread(RELAY, ["g1"]), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() =>
      expect(queryClient.getQueryState(["nip29", "unread", RELAY, "g1", USER])?.status).toBe("success"),
    );
    expect(result.current.anyUnread).toBe(false);
  });

  it("merges refetched snapshots with tail-delivered events (refetch can't clear a badge)", async () => {
    const { relay, queryClient } = setup();

    const { result } = renderHook(() => useRelayUnread(RELAY, ["g1"]), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() =>
      expect(queryClient.getQueryState(["nip29", "unread", RELAY, "g1", USER])?.status).toBe("success"),
    );

    // Tail-only delivery (not in relay history), then a forced refetch that
    // returns nothing — the healing poll must not wipe the badge.
    relay.emit(msg("g1"));
    await waitFor(() => expect(result.current.anyUnread).toBe(true));

    await queryClient.refetchQueries({ queryKey: ["nip29", "unread", RELAY] });
    expect(result.current.anyUnread).toBe(true);
  });
});

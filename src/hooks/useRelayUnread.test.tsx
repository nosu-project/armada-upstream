/**
 * Regression tests for the NIP-29 unread/badge pipeline — "messages sync but
 * channels never light up".
 *
 * Post-wire architecture: badges are derived purely from the shared IndexedDB
 * event store (which the wire keeps fed) plus the user's read-state; the wire
 * bus triggers a re-derive the moment a watched group's store changes. The
 * hook holds no sockets, so badge state can no longer evaporate on remount or
 * die with a socket.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { emitWireScopes, resetWireBus } from "@/wire/bus";

import { useRelayUnread } from "./useRelayUnread";

import type { NostrEvent } from "@nostrify/nostrify";

// ── Module mocks ─────────────────────────────────────────────────────────────

const USER = "f".repeat(64);
const OTHER = "a".repeat(64);
const RELAY = "wss://test.relay";

const h = vi.hoisted(() => ({
  store: { events: [] as unknown[] },
  readState: {} as Record<string, number>,
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () =>
    Promise.resolve({
      query: async (filters: Array<{ kinds?: number[]; "#h"?: string[]; limit?: number }>) => {
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

afterEach(() => resetWireBus());

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

function setup() {
  h.store.events = [];
  h.readState = {};
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useRelayUnread", () => {
  it("lights the badge from store history newer than read-state", async () => {
    const { wrapper } = setup();
    h.store.events.push(msg("g1"));

    const { result } = renderHook(() => useRelayUnread(RELAY, ["g1", "g2"]), { wrapper });

    await waitFor(() => expect(result.current.anyUnread).toBe(true));
    expect(result.current.byGroup["g1"]).toBeDefined();
    expect(result.current.byGroup["g2"]).toBeUndefined();
  });

  it("re-derives when the wire announces new activity for a watched group", async () => {
    const { queryClient, wrapper } = setup();

    const { result } = renderHook(() => useRelayUnread(RELAY, ["g1"]), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState(["nip29", "unread", RELAY, "g1", USER])?.status).toBe("success"),
    );
    expect(result.current.anyUnread).toBe(false);

    // The wire ingests a message into the store, then rings the bus.
    h.store.events.push(msg("g1", { ptag: USER }));
    emitWireScopes(["nip29:g1"]);

    await waitFor(() => expect(result.current.anyUnread).toBe(true));
    expect(result.current.byGroup["g1"].mention).toBe(true);
  });

  it("ignores wire announcements for unwatched groups", async () => {
    const { queryClient, wrapper } = setup();
    renderHook(() => useRelayUnread(RELAY, ["g1"]), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState(["nip29", "unread", RELAY, "g1", USER])?.status).toBe("success"),
    );
    const fetches = queryClient.getQueryState(["nip29", "unread", RELAY, "g1", USER])!.dataUpdateCount;

    emitWireScopes(["nip29:other-group"]);
    await new Promise((r) => setTimeout(r, 150));

    expect(queryClient.getQueryState(["nip29", "unread", RELAY, "g1", USER])!.dataUpdateCount).toBe(fetches);
  });

  it("never counts self-authored messages as unread", async () => {
    const { queryClient, wrapper } = setup();
    h.store.events.push(msg("g1", { pubkey: USER }));

    const { result } = renderHook(() => useRelayUnread(RELAY, ["g1"]), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState(["nip29", "unread", RELAY, "g1", USER])?.status).toBe("success"),
    );
    expect(result.current.anyUnread).toBe(false);
  });

  it("respects read-state: messages at or before last-read don't count", async () => {
    const { queryClient, wrapper } = setup();
    const ts = Math.floor(Date.now() / 1000);
    h.store.events.push(msg("g1", { created_at: ts }));
    h.readState = { [`${RELAY}::g1`]: ts };

    const { result } = renderHook(() => useRelayUnread(RELAY, ["g1"]), { wrapper });
    await waitFor(() =>
      expect(queryClient.getQueryState(["nip29", "unread", RELAY, "g1", USER])?.status).toBe("success"),
    );
    expect(result.current.anyUnread).toBe(false);
  });
});

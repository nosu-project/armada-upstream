/**
 * Concord V1's first unread model: badges derived purely from the wire-fed
 * shared event store (sealed kind-3300 outers carry real timestamps + their
 * `#z` pseudonym, so the cheap pass needs no decryption; only newer-than-read
 * outers are opened, to exclude self-authored messages and spot mentions).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { emitWireScopes, resetWireBus } from "@/wire/bus";

import { useConcord1Unread } from "./useConcord1Unread";

import type { Community } from "@/concord-v1/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";

// ── Module mocks ─────────────────────────────────────────────────────────────

const USER = "f".repeat(64);
const OTHER = "a".repeat(64);

const h = vi.hoisted(() => ({
  store: { events: [] as unknown[] },
  // outer event id → decrypted author/mention (the fake "decrypt").
  opened: new Map<string, { author: string; mention?: boolean }>(),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () =>
    Promise.resolve({
      query: async (filters: Array<{ kinds?: number[]; "#z"?: string[]; limit?: number }>) => {
        const events = h.store.events as NostrEvent[];
        const out: NostrEvent[] = [];
        for (const f of filters) {
          for (const ev of events) {
            if (f.kinds && !f.kinds.includes(ev.kind)) continue;
            if (f["#z"] && !ev.tags.some(([n, v]) => n === "z" && f["#z"]!.includes(v))) continue;
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
// The decode cache is exercised by the channel-hook tests; here we fake the
// decrypt so the test controls authorship/mentions without real crypto.
vi.mock("@/concord-v1/lib/decodeCache", () => ({
  openMemoizedBatch: async (events: NostrEvent[]) =>
    events
      .map((ev) => {
        const info = h.opened.get(ev.id);
        if (!info) return undefined;
        return {
          messageId: `m-${ev.id}`,
          author: info.author,
          content: "x",
          ms: ev.created_at * 1000,
          createdAt: ev.created_at,
          kind: 3300,
          wrapperId: ev.id,
          tags: info.mention ? [["p", USER]] : [],
        };
      })
      .filter(Boolean),
}));

afterEach(() => resetWireBus());

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CHANNEL_ID = new Uint8Array(32).fill(7);
const CHANNEL_HEX = bytesToHex(CHANNEL_ID);
const KEY = new Uint8Array(32).fill(1);

function community(): Community {
  return {
    id: new Uint8Array(32).fill(6),
    name: "Test",
    relays: ["wss://c.relay"],
    channels: [
      {
        id: CHANNEL_ID,
        name: "general",
        key: KEY,
        epoch: 0n,
        epochKeys: [{ epoch: 0n, key: KEY }],
      },
    ],
  } as unknown as Community;
}

let eventSeq = 0;
function sealedOuter(z: string, opts: { created_at?: number; author?: string; mention?: boolean } = {}): NostrEvent {
  const ev: NostrEvent = {
    id: `${eventSeq++}`.padStart(64, "3"),
    kind: 3300,
    pubkey: "0".repeat(64), // pseudonymous outer key — never the real author
    created_at: opts.created_at ?? Math.floor(Date.now() / 1000),
    content: "ciphertext",
    tags: [["z", z]],
    sig: "",
  };
  h.opened.set(ev.id, { author: opts.author ?? OTHER, mention: opts.mention });
  return ev;
}

/** The z pseudonym the hook derives for our fixture channel/epoch. */
async function fixtureZ(): Promise<string> {
  const { channelZs } = await import("@/concord-v1/lib/concordNotifications");
  return channelZs(community().channels[0])[0];
}

function setup() {
  h.store.events = [];
  h.opened.clear();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useConcord1Unread", () => {
  it("badges a channel with sealed history newer than last-read", async () => {
    const { wrapper } = setup();
    h.store.events.push(sealedOuter(await fixtureZ(), { mention: true }));

    const { result } = renderHook(() => useConcord1Unread(community()), { wrapper });

    await waitFor(() => expect(result.current.byChannel[CHANNEL_HEX]).toBeDefined());
    expect(result.current.byChannel[CHANNEL_HEX].mention).toBe(true);
  });

  it("re-derives when the wire announces a c1 scope for the channel", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useConcord1Unread(community()), { wrapper });
    await waitFor(() => expect(Object.keys(result.current.byChannel)).toHaveLength(0));

    h.store.events.push(sealedOuter(await fixtureZ()));
    emitWireScopes([`c1:${CHANNEL_HEX}`]);

    await waitFor(() => expect(result.current.byChannel[CHANNEL_HEX]).toBeDefined());
  });

  it("never badges self-authored messages", async () => {
    const { queryClient, wrapper } = setup();
    h.store.events.push(sealedOuter(await fixtureZ(), { author: USER }));

    const { result } = renderHook(() => useConcord1Unread(community()), { wrapper });
    await waitFor(() =>
      expect(
        queryClient.getQueryCache().findAll({ queryKey: ["concord1-unread"] })[0]?.state.status,
      ).toBe("success"),
    );
    expect(result.current.byChannel[CHANNEL_HEX]).toBeUndefined();
  });

  it("markRead clears the badge (monotonic read stamp)", async () => {
    const { wrapper } = setup();
    const ts = Math.floor(Date.now() / 1000);
    h.store.events.push(sealedOuter(await fixtureZ(), { created_at: ts }));

    const { result } = renderHook(() => useConcord1Unread(community()), { wrapper });
    await waitFor(() => expect(result.current.byChannel[CHANNEL_HEX]).toBeDefined());

    result.current.markRead(CHANNEL_HEX, ts);
    await waitFor(() => expect(result.current.byChannel[CHANNEL_HEX]).toBeUndefined());
  });
});

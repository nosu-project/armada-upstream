/**
 * The embed lookup's fallback depth: pool → identifier hints + author outbox →
 * (opt-in) events that reference the id. Each relay is modelled as its own
 * store, so a test can place the target exactly where only one step reaches.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publicRelayHints, useAddrEvent, useEvent } from "./useEvent";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

const TARGET_AUTHOR = "a".repeat(64);
const QUOTER = "b".repeat(64);
const REPLIER = "c".repeat(64);
const TARGET_ID = "1".repeat(64);
const POOL = "pool";
const OUTBOX = "wss://outbox.example";
const HINTED = "wss://hinted.example";

const h = vi.hoisted(() => ({
  relays: new Map<string, NostrEvent[]>(),
  groupCalls: [] as string[][],
}));

function matches(ev: NostrEvent, f: NostrFilter): boolean {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  for (const [key, values] of Object.entries(f)) {
    if (!key.startsWith("#")) continue;
    const name = key.slice(1);
    if (!ev.tags.some((t) => t[0] === name && (values as string[]).includes(t[1]))) return false;
  }
  return true;
}

function serve(urls: string[], filters: NostrFilter[]): NostrEvent[] {
  const out: NostrEvent[] = [];
  for (const url of urls) {
    for (const ev of h.relays.get(url) ?? []) {
      if (filters.some((f) => matches(ev, f)) && !out.includes(ev)) out.push(ev);
    }
  }
  return out;
}

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      query: async (filters: NostrFilter[]) => serve([POOL], filters),
      group: (urls: string[]) => {
        h.groupCalls.push(urls);
        return { query: async (filters: NostrFilter[]) => serve(urls, filters) };
      },
    },
  }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: async () => [], event: async () => {} }),
}));

function ev(partial: Partial<NostrEvent> & Pick<NostrEvent, "pubkey" | "kind">): NostrEvent {
  return { id: "f".repeat(64), created_at: 1, tags: [], content: "", sig: "", ...partial };
}

const target = ev({ id: TARGET_ID, pubkey: TARGET_AUTHOR, kind: 1, content: "hi" });
const relayList = (pubkey: string, url: string) => ev({ id: "2".repeat(64), pubkey, kind: 10002, tags: [["r", url]] });

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  h.relays = new Map();
  h.groupCalls = [];
});

describe("useEvent", () => {
  it("finds the event on the quoting author's outbox when the identifier names no author", async () => {
    // The quoter's 10002 is on the pool; the target lives only on their outbox.
    h.relays.set(POOL, [relayList(QUOTER, OUTBOX)]);
    h.relays.set(OUTBOX, [target]);
    const { result } = renderHook(
      () => useEvent(TARGET_ID, undefined, undefined, { fallbackAuthor: QUOTER }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe(TARGET_ID);
  });

  it("chases the relay hint on a reply that references the id", async () => {
    const reply = ev({ id: "3".repeat(64), pubkey: REPLIER, kind: 1, tags: [["e", TARGET_ID, HINTED]] });
    h.relays.set(POOL, [reply]);
    h.relays.set(HINTED, [target]);
    const { result } = renderHook(() => useEvent(TARGET_ID, undefined, undefined, { discover: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe(TARGET_ID);
  });

  it("chases the author a reference names on its tag, through their outbox", async () => {
    const quote = ev({ id: "3".repeat(64), pubkey: REPLIER, kind: 1, tags: [["q", TARGET_ID, "", TARGET_AUTHOR]] });
    h.relays.set(POOL, [quote, relayList(TARGET_AUTHOR, OUTBOX)]);
    h.relays.set(OUTBOX, [target]);
    const { result } = renderHook(() => useEvent(TARGET_ID, undefined, undefined, { discover: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe(TARGET_ID);
  });

  it("does not dial a reference's loopback or LAN relay hint", async () => {
    const reply = ev({
      id: "3".repeat(64),
      pubkey: REPLIER,
      kind: 1,
      tags: [["e", TARGET_ID, "ws://192.168.1.1"], ["e", TARGET_ID, "wss://localhost:7777"]],
    });
    h.relays.set(POOL, [reply]);
    const { result } = renderHook(() => useEvent(TARGET_ID, undefined, undefined, { discover: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(h.groupCalls.flat()).toEqual([]);
  });

  it("does not ask about references unless discovery is opted into", async () => {
    const reply = ev({ id: "3".repeat(64), pubkey: REPLIER, kind: 1, tags: [["e", TARGET_ID, HINTED]] });
    h.relays.set(POOL, [reply]);
    h.relays.set(HINTED, [target]);
    const { result } = renderHook(() => useEvent(TARGET_ID), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(h.groupCalls).toEqual([]);
  });

  it("finds the event again on refetch once it has appeared", async () => {
    const { result } = renderHook(() => useEvent(TARGET_ID, [HINTED]), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();

    h.relays.set(HINTED, [target]);
    await result.current.refetch();
    await waitFor(() => expect(result.current.data?.id).toBe(TARGET_ID));
  });
});

describe("useAddrEvent", () => {
  it("falls back to the author's outbox", async () => {
    const article = ev({ id: "4".repeat(64), pubkey: TARGET_AUTHOR, kind: 30023, tags: [["d", "post"]] });
    h.relays.set(POOL, [relayList(TARGET_AUTHOR, OUTBOX)]);
    h.relays.set(OUTBOX, [article]);
    const { result } = renderHook(
      () => useAddrEvent({ kind: 30023, pubkey: TARGET_AUTHOR, identifier: "post" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe(article.id);
  });
});

describe("publicRelayHints", () => {
  it("keeps public wss hints and drops plaintext, private and junk ones", () => {
    expect(publicRelayHints([
      "wss://relay.example",
      "ws://relay.example",
      "wss://127.0.0.1",
      "wss://[::1]:8080",
      "wss://10.0.0.2",
      "wss://printer.local",
      "",
      "/",
    ])).toEqual(["wss://relay.example"]);
  });
});

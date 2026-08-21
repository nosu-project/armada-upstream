/**
 * The gossip session's lifecycle — the half of Mini App multiplayer that live
 * testing cannot reach, because every fault here is silent. A session that is
 * not left keeps receiving into an unmounted hook; a departure sealed to the
 * wrong channel leaves the room you left dialling a node that has gone. Both
 * look exactly like a working game to whoever is still playing.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { base32Encode, encodeNodeAddr } from "@/lib/webxdcRealtime";

const h = vi.hoisted(() => ({
  transport: undefined as unknown,
  published: [] as { content: string; tags: string[][]; channel: string }[],
  peerRows: [] as { author: string; content: string; ms: number }[],
  resolveTransport: undefined as ((t: unknown) => void) | undefined,
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: { relay: () => ({ event: vi.fn() }) } }) }));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "me".repeat(32), signer: {} } }),
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({ useControlFold: () => ({ data: undefined }) }));
vi.mock("@/wire/useWireScopes", () => ({ useWireScopes: () => undefined }));
vi.mock("@/concord/lib/disappearing", () => ({
  chatExpiresAt: () => undefined,
  messageExpirationOf: () => undefined,
}));
vi.mock("@/concord/lib/rumorStore", () => ({
  writeRumors: vi.fn(),
  queryWebxdcRumors: async () => [],
  queryWebxdcPeerSignals: async () => h.peerRows,
}));
vi.mock("@/lib/realtimeTransport", () => ({
  realtimeTransport: () => (h.transport ? Promise.resolve(h.transport) : new Promise((r) => { h.resolveTransport = r; })),
}));

// The seal/wrap layer: record what a publish would have put on the wire, and
// which channel it was bound to.
let currentChannelHex = "";
vi.mock("@/concord/lib/stream", () => ({
  buildRumor: ({ content, tags }: { content: string; tags: string[][] }) => (
    h.published.push({
      content,
      tags,
      channel: tags.find(([n]) => n === "channel")?.[1] ?? "",
    }),
    {
    id: "r".repeat(64),
    content,
    tags,
    created_at: 1,
  }
  ),
  channelBindingTags: () => [["channel", currentChannelHex]],
  checkChannelBinding: () => undefined,
  openWrap: () => undefined,
  sealRumor: async () => ({ id: "s" }),
  wrapSeal: (_seal: unknown, _g: unknown) => ({ id: "w", pubkey: "p" }),
}));

import { useConcordAppSync } from "./useConcordAppSync";

const TOPIC = base32Encode(new Uint8Array(32).fill(7));

function fakeTransport() {
  return {
    publicKeyHex: () => "ab".repeat(32),
    nodeAddrJson: () => JSON.stringify({ id: "x", addrs: [] }),
    join: vi.fn(async (): Promise<void> => undefined),
    send: vi.fn(async (_topic: Uint8Array, _frame: Uint8Array): Promise<void> => undefined),
    addPeer: vi.fn(async (_topic: Uint8Array, _json: string): Promise<void> => undefined),
    leave: vi.fn((_topic: Uint8Array) => undefined),
  };
}

const chan = (hex: string) =>
  ({
    idHex: hex,
    id: new Uint8Array(32),
    current: { epoch: 1n, group: { pk: "pk", convKey: new Uint8Array(32) } },
    streams: [],
  }) as never;

const community = { idHex: "c".repeat(64), id: new Uint8Array(32), relays: ["wss://r"] } as never;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => {
  h.transport = undefined;
  h.peerRows = [];
  h.resolveTransport = undefined;
  currentChannelHex = "a".repeat(64);
});

describe("the gossip session lifecycle", () => {
  it("leaves a session whose owner went away while the join was in flight", async () => {
    // The window that actually leaks: the subscription lands AFTER the hook is
    // gone. Nothing cancels it, so the topic stays subscribed, the next join
    // adopts it, and every frame goes to the callback of a hook that no longer
    // exists — a game that sends fine and never receives.
    const t = fakeTransport();
    let finishJoin: () => void = () => {};
    t.join = vi.fn((): Promise<void> => new Promise<void>((r) => { finishJoin = () => r(); }));
    h.transport = t;
    const { unmount } = renderHook(() => useConcordAppSync(community, chan("a".repeat(64)), TOPIC), { wrapper });
    await waitFor(() => expect(t.join).toHaveBeenCalled());
    unmount();
    finishJoin();
    await waitFor(() => expect(t.leave).toHaveBeenCalled());
  });

  it("leaves on a clean unmount too", async () => {
    h.transport = fakeTransport();
    const t = h.transport as ReturnType<typeof fakeTransport>;
    const { unmount } = renderHook(() => useConcordAppSync(community, chan("a".repeat(64)), TOPIC), { wrapper });
    await waitFor(() => expect(t.join).toHaveBeenCalled());
    unmount();
    expect(t.leave).toHaveBeenCalled();
  });

  it("dials no more than the cap, newest first", async () => {
    h.transport = fakeTransport();
    const t = h.transport as ReturnType<typeof fakeTransport>;
    const addr = (n: number) => encodeNodeAddr(JSON.stringify({ id: `peer${n}`, addrs: [] }));
    h.peerRows = Array.from({ length: 40 }, (_, i) => ({
      author: `peer${i}`,
      ms: 1000 + i,
      content: JSON.stringify({ op: "ad", topic: TOPIC, addr: addr(i) }),
    }));
    renderHook(() => useConcordAppSync(community, chan("a".repeat(64)), TOPIC), { wrapper });
    await waitFor(() => expect(t.addPeer.mock.calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(t.addPeer.mock.calls.length).toBe(16));
    // Newest first: a channel's fold is mostly ghosts of members who closed a
    // tab, and the recent advertisement is likelier to still answer.
    // The transport is handed decoded JSON, so the newest peer's id is in it.
    expect(t.addPeer.mock.calls[0][1]).toContain("peer39");
  });
});

describe("the departure signal", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const left = () => h.published.filter((p) => p.content.includes('"op":"left"'));

  beforeEach(() => {
    h.published = [];
  });

  it("is published, bound to the channel the session belonged to", async () => {
    h.transport = fakeTransport();
    const t = h.transport as ReturnType<typeof fakeTransport>;
    currentChannelHex = A;
    const { unmount } = renderHook(() => useConcordAppSync(community, chan(A), TOPIC), { wrapper });
    await waitFor(() => expect(t.join).toHaveBeenCalled());
    h.published = [];
    unmount();
    await waitFor(() => expect(left()).toHaveLength(1));
    expect(left()[0].channel).toBe(A);
    expect(left()[0].content).toContain(TOPIC);
  });

  it("is skipped rather than sealed into the channel you switched TO", async () => {
    // React runs a dep-change cleanup during the commit of the render that
    // changed the deps, when the publisher already points at the new channel.
    // Publishing there would tell the wrong room, and leave the room actually
    // left dialling a node that has gone.
    h.transport = fakeTransport();
    const t = h.transport as ReturnType<typeof fakeTransport>;
    currentChannelHex = A;
    const { rerender } = renderHook(({ c }: { c: string }) => useConcordAppSync(community, chan(c), TOPIC), {
      wrapper,
      initialProps: { c: A },
    });
    await waitFor(() => expect(t.join).toHaveBeenCalled());
    h.published = [];
    currentChannelHex = B;
    rerender({ c: B });
    await waitFor(() => expect(t.leave).toHaveBeenCalled());
    // Nothing was addressed to B on the way out of A.
    expect(left().filter((p) => p.channel === B)).toHaveLength(0);
  });
});

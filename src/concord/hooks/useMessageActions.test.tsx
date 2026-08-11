/**
 * Sending recovery: the "Failed to send" retry and the late-ACK clear.
 *
 * Two bugs this pins:
 *
 *  1. RETRY RE-SENDS THE ORIGINAL. A retry used to mint a brand-new rumor (a
 *     fresh id) and drop the failed one, so a message that had actually reached
 *     a relay — we merely timed out waiting for its OK — reappeared as a
 *     DUPLICATE. `retry` now re-broadcasts the SAME message under its own rumor
 *     id, which dedupes against any copy that did land.
 *
 *  2. A LATE ACK CLEARS THE BADGE. `broadcastWrap` marks a message "failed"
 *     when no relay accepts within the signer's budget, but keeps the publishes
 *     running past that decision — so a slow relay's late OK (evidence the
 *     message DID reach a relay) retires the badge instead of stranding a
 *     delivered message as unsent.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { openChatBatch, type OpenedChat } from "@/concord/lib/chat";
import { bytesToHex, channelGroupKey, voiceGroupKey, voiceMediaKey } from "@/concord/lib/derive";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";
import type { SendStatus } from "@/hooks/useSendStatusMap";

import { broadcastWrap, channelKey, useMessageActions } from "./useChannel";

const CID = "cc".repeat(32);
const RELAY = "wss://test.relay";
const root = new Uint8Array(32).fill(3);

// ── Controllable module state ────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  pool: undefined as unknown,
  user: undefined as unknown,
  status: {} as Record<string, SendStatus>,
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: h.pool }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: undefined }),
  useDissolved: () => ({ data: null }),
  citationFor: () => undefined,
  dissolvedAt: async () => undefined,
}));
vi.mock("@/hooks/useSendStatusMap", () => ({
  useSendStatusMap: () => ({
    status: h.status,
    setStatus: (id: string, value: SendStatus | undefined) => {
      if (value === undefined) delete h.status[id];
      else h.status[id] = value;
    },
  }),
  useSendStatusMapValue: () => h.status,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

let nextChannelByte = 40;
function makeChannel(): { channel: Channel; idHex: string } {
  const channelId = new Uint8Array(32).fill(nextChannelByte++);
  const idHex = bytesToHex(channelId);
  const group = channelGroupKey(root, channelId, 0);
  const stream = { epoch: 0n, group };
  const voice = { room: voiceGroupKey(root, channelId, 0), mediaKey: voiceMediaKey(root, channelId, 0) };
  return {
    channel: { id: channelId, idHex, name: "general", isPrivate: false, voice, streams: [stream], current: stream },
    idHex,
  };
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

/** A relay that records every published event, optionally rejecting them. */
class CapturingRelay {
  sent: NostrEvent[] = [];
  reject = false;
  async event(ev: NostrEvent): Promise<void> {
    this.sent.push(ev);
    if (this.reject) throw new Error("rejected");
  }
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

/** Build a "broadcast-failed" optimistic row: a real, signed seal + wrap. */
async function failedRow(
  channel: Channel,
  idHex: string,
  s: ReturnType<typeof signer>,
  content: string,
): Promise<OpenedChat> {
  const ms = Date.now();
  const tags = [...channelBindingTags(idHex, 0n)];
  const rumor = buildRumor({ kind: KIND_MESSAGE, content, tags, pubkey: s.pubkey, ms });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, s);
  const wrap = wrapSeal(seal, channel.current.group);
  return {
    rumorId: rumor.id,
    author: s.pubkey,
    kind: KIND_MESSAGE,
    content,
    tags,
    ms,
    createdAt: rumor.created_at,
    wrapId: wrap.id,
    streamPk: wrap.pubkey,
    sealKind: KIND_SEAL_ENCRYPTED,
    seal,
    channelIdHex: idHex,
    epoch: 0n,
  };
}

afterEach(() => {
  h.status = {};
  h.pool = undefined;
  h.user = undefined;
});

// ── retry (bug #1) ───────────────────────────────────────────────────────────

describe("useMessageActions.retry", () => {
  it("re-sends the ORIGINAL failed message under its own rumor id (no duplicate)", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    h.user = { pubkey: alice.pubkey, method: "nsec", signer: alice };
    const relay = new CapturingRelay();
    h.pool = { relay: () => relay };

    const row = await failedRow(channel, idHex, alice, "hello");
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    const { queryClient, wrapper } = makeWrapper();
    queryClient.setQueryData(channelKey(idHex), [row]);
    h.status[row.rumorId] = "failed";

    const { result } = renderHook(() => useMessageActions(community, channel), { wrapper });
    act(() => result.current.retry(row.rumorId));

    await waitFor(() => expect(relay.sent.length).toBe(1));
    // The re-broadcast wrap opens to the SAME rumor id — not a fresh one.
    const reopened = await openChatBatch(relay.sent, channel);
    expect(reopened.map((m) => m.rumorId)).toEqual([row.rumorId]);
    // And the relay's accept retires the failed badge.
    await waitFor(() => expect(h.status[row.rumorId]).toBeUndefined());
  });

  it("re-asserts failed when the retry also finds no relay", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    h.user = { pubkey: alice.pubkey, method: "nsec", signer: alice };
    const relay = new CapturingRelay();
    relay.reject = true;
    h.pool = { relay: () => relay };

    const row = await failedRow(channel, idHex, alice, "hello");
    const community = { idHex: CID, relays: [RELAY] } as unknown as Community;
    const { queryClient, wrapper } = makeWrapper();
    queryClient.setQueryData(channelKey(idHex), [row]);
    h.status[row.rumorId] = "failed";

    const { result } = renderHook(() => useMessageActions(community, channel), { wrapper });
    act(() => result.current.retry(row.rumorId));

    await waitFor(() => expect(relay.sent.length).toBe(1));
    await waitFor(() => expect(h.status[row.rumorId]).toBe("failed"));
    // The row is preserved (same id), never dropped for a fresh send.
    const rows = (queryClient.getQueryData(channelKey(idHex)) ?? []) as OpenedChat[];
    expect(rows.map((m) => m.rumorId)).toEqual([row.rumorId]);
  });
});

// ── broadcastWrap (bug #2) ───────────────────────────────────────────────────

describe("broadcastWrap", () => {
  const wrap = { id: "deadbeefcafef00d" } as NostrEvent;

  it("clears the status the moment a relay accepts", async () => {
    const nostr = { relay: () => ({ event: () => Promise.resolve() }) };
    const seen: Array<SendStatus | undefined> = [];
    broadcastWrap(nostr, ["wss://a"], wrap, "nsec", (s) => seen.push(s));
    await waitFor(() => expect(seen).toContain(undefined));
    expect(seen).not.toContain("failed");
  });

  it("marks failed when no relay accepts", async () => {
    const nostr = { relay: () => ({ event: () => Promise.reject(new Error("no")) }) };
    const seen: Array<SendStatus | undefined> = [];
    broadcastWrap(nostr, ["wss://a", "wss://b"], wrap, "nsec", (s) => seen.push(s));
    await waitFor(() => expect(seen).toContain("failed"));
    expect(seen[seen.length - 1]).toBe("failed");
  });

  it("marks failed immediately when there are no relays", () => {
    const seen: Array<SendStatus | undefined> = [];
    broadcastWrap({ relay: () => ({ event: () => Promise.resolve() }) }, [], wrap, "nsec", (s) => seen.push(s));
    expect(seen).toEqual(["failed"]);
  });

  it("clears a failed message when a relay accepts LATE, past the decision window", async () => {
    vi.useFakeTimers();
    try {
      let accept!: () => void;
      const nostr = { relay: () => ({ event: () => new Promise<void>((r) => (accept = r)) }) };
      const seen: Array<SendStatus | undefined> = [];
      broadcastWrap(nostr, ["wss://a"], wrap, "nsec", (s) => seen.push(s));

      // The 8s local-signer budget elapses with the publish still pending.
      await vi.advanceTimersByTimeAsync(8_000);
      expect(seen).toEqual(["failed"]);

      // A late ACK within the grace window is evidence it reached a relay.
      accept();
      await vi.advanceTimersByTimeAsync(0);
      expect(seen[seen.length - 1]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

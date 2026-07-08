/**
 * Regression tests for the Concord V2 background-channel gap — "messages for
 * channels you aren't looking at never light a badge and don't render until a
 * relay round-trip on switch".
 *
 * Only the OPEN channel had a live wrap subscription (`useChannelTimeline2`),
 * so on web a wrap for any other channel of the community was never received,
 * never decrypted, never written to the rumor store — and since opening a
 * channel immediately stamps it read, its unread badge could effectively never
 * light. On Android the native service parked raw wraps, but nothing drained
 * them until the channel was opened, so push-notified messages didn't badge
 * in-app either.
 *
 * Pins the fixes:
 *  - `useCommunityPlaneSync2` live-syncs ALL channels' streams into the rumor
 *    store (+ loaded timeline caches);
 *  - `useConcord2Unread` drains native-parked wraps during its badge scan.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { openChatBatch, type OpenedChat } from "@/concord-v2/lib/chat";
import { bytesToHex, channelGroupKey } from "@/concord-v2/lib/derive";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord-v2/lib/kinds";
import {
  parkPendingWraps,
  peekPendingWraps,
  queryChannelRumors,
} from "@/concord-v2/lib/rumorStore";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord-v2/lib/stream";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

import { channelKey } from "./useChannel2";
import { useCommunityPlaneSync2 } from "./useCommunityPlaneSync2";
import { useConcord2Unread } from "./useConcord2Unread";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  pool: undefined as unknown,
  userPubkey: "f".repeat(64),
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: h.pool }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: h.userPubkey } }),
}));

// ── Fake relay (pushable live req) ───────────────────────────────────────────

interface Filter {
  kinds?: number[];
  authors?: string[];
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
        (!f.authors || f.authors.includes(ev.pubkey)) &&
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

const RELAY = "wss://test.relay";
const root = new Uint8Array(32).fill(7);

/** Distinct channel ids per test so the shared IndexedDB stores can't cross-talk. */
let nextChannelByte = 90;
function makeChannel(): { channel: ChannelV2; idHex: string } {
  const channelId = new Uint8Array(32).fill(nextChannelByte++);
  const idHex = bytesToHex(channelId);
  const group = channelGroupKey(root, channelId, 0);
  const stream = { epoch: 0n, group };
  return {
    channel: {
      id: channelId,
      idHex,
      name: "general",
      isPrivate: false,
      isVoice: false,
      streams: [stream],
      current: stream,
    },
    idHex,
  };
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

/** A freshly-published chat wrap (outer created_at = now). */
async function wrapChat(
  channel: ChannelV2,
  s: ReturnType<typeof signer>,
  content: string,
  extraRumorTags: string[][] = [],
): Promise<NostrEvent> {
  const rumor = buildRumor({
    kind: KIND_MESSAGE,
    content,
    tags: [...channelBindingTags(channel.idHex, 0n), ...extraRumorTags],
    pubkey: s.pubkey,
    ms: Date.now(),
  });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, s);
  return wrapSeal(seal, channel.current.group) as NostrEvent;
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function makeCommunity(): CommunityV2 {
  return { idHex: "cd".repeat(32), relays: [RELAY] } as unknown as CommunityV2;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useCommunityPlaneSync2", () => {
  it("decrypts a live wrap for a NON-open channel into the rumor store", async () => {
    const a = makeChannel();
    const b = makeChannel();
    const alice = signer();
    const relay = new FakeRelay();
    h.pool = { relay: () => relay };

    const { wrapper } = makeWrapper();
    renderHook(() => useCommunityPlaneSync2(makeCommunity(), [a.channel, b.channel]), { wrapper });

    // A message lands in channel B while the user is (nominally) in channel A.
    const wrap = await wrapChat(b.channel, alice, "psst — channel B");
    await waitFor(() => expect(relay).toBeDefined());
    relay.emit(wrap);

    // It must be decrypted and durable in B's rumor store — the source the
    // unread scan and B's cold open both read from.
    await waitFor(async () => {
      const rumors = await queryChannelRumors(b.idHex, { limit: 10 });
      expect(rumors.some((r) => r.content === "psst — channel B")).toBe(true);
    });
  });

  it("paints into an already-loaded timeline cache, but never over an unloaded one", async () => {
    const a = makeChannel();
    const b = makeChannel();
    const alice = signer();
    const relay = new FakeRelay();
    h.pool = { relay: () => relay };

    const { queryClient, wrapper } = makeWrapper();
    // Channel A has completed an initial load (non-empty cache); B has not.
    const seededWrap = await wrapChat(a.channel, alice, "existing");
    const seeded = await openChatBatch([seededWrap], a.channel);
    queryClient.setQueryData<OpenedChat[]>(channelKey(a.idHex), seeded);

    renderHook(() => useCommunityPlaneSync2(makeCommunity(), [a.channel, b.channel]), { wrapper });

    relay.emit(await wrapChat(a.channel, alice, "for A"));
    relay.emit(await wrapChat(b.channel, alice, "for B"));

    await waitFor(() => {
      const cached = queryClient.getQueryData<OpenedChat[]>(channelKey(a.idHex));
      expect(cached?.some((m) => m.content === "for A")).toBe(true);
    });
    // B's rumor is stored (durable) but its cache is untouched — its own
    // queryFn owns the first paint (no lone row over the loading skeleton).
    await waitFor(async () => {
      const rumors = await queryChannelRumors(b.idHex, { limit: 10 });
      expect(rumors.some((r) => r.content === "for B")).toBe(true);
    });
    expect(queryClient.getQueryData(channelKey(b.idHex))).toBeUndefined();
  });
});

describe("useConcord2Unread — native parked-wrap drain", () => {
  it("drains parked wraps during the badge scan: badge lights, wraps acked", async () => {
    const b = makeChannel();
    const alice = signer();

    // The native service parked a wrap for a channel the user never opened.
    const wrap = await wrapChat(b.channel, alice, "pushed while away", [["p", h.userPubkey]]);
    parkPendingWraps([wrap]);
    await waitFor(async () => {
      expect((await peekPendingWraps([b.channel.current.group.pk])).length).toBe(1);
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useConcord2Unread([b.channel]), { wrapper });

    // The scan decrypts the parked wrap → the channel badges, with mention.
    await waitFor(() => {
      expect(result.current.byChannel[b.idHex]).toBeDefined();
      expect(result.current.byChannel[b.idHex].mention).toBe(true);
    });

    // Decoded wraps are acknowledged (removed from the pending store)…
    await waitFor(async () => {
      expect((await peekPendingWraps([b.channel.current.group.pk])).length).toBe(0);
    });
    // …because their rumors are now durable in the opened-event store.
    await waitFor(async () => {
      const rumors = await queryChannelRumors(b.idHex, { limit: 10 });
      expect(rumors.some((r) => r.content === "pushed while away")).toBe(true);
    });
  });

  it("self-authored parked wraps never light the badge", async () => {
    const b = makeChannel();
    const me = signer();
    h.userPubkey = me.pubkey;

    parkPendingWraps([await wrapChat(b.channel, me, "my own message")]);
    await waitFor(async () => {
      expect((await peekPendingWraps([b.channel.current.group.pk])).length).toBe(1);
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useConcord2Unread([b.channel]), { wrapper });

    // Drain happens (wrap acked) but nothing badges.
    await waitFor(async () => {
      expect((await peekPendingWraps([b.channel.current.group.pk])).length).toBe(0);
    });
    expect(result.current.byChannel[b.idHex]).toBeUndefined();
  });
});

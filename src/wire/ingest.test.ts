/**
 * The wire's single ingestion point: every transport (web sockets, the APK
 * service's live feed and drain) funnels through `ingestWireEvents`, which
 * routes into IndexedDB (plaintext → armada-events; decryptable V2 wraps →
 * rumor store; unknown wraps → parked) and announces changed scopes on the
 * bus. These tests pin that routing.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";

import { bytesToHex, channelGroupKey, voiceGroupKey, voiceMediaKey } from "@/concord-v2/lib/derive";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord-v2/lib/kinds";
import { peekPendingWraps, queryChannelRumors } from "@/concord-v2/lib/rumorStore";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord-v2/lib/stream";
import type { ChannelV2 } from "@/concord-v2/lib/types";

import { onWireScopes, resetWireBus } from "./bus";
import { ingestWireEvents, type WireEventStore } from "./ingest";
import type { WireSpec } from "./spec";

afterEach(() => resetWireBus());

// ── Fixtures ─────────────────────────────────────────────────────────────────

const root = new Uint8Array(32).fill(9);
let nextChannelByte = 120;
function makeChannel(): { channel: ChannelV2; idHex: string } {
  const channelId = new Uint8Array(32).fill(nextChannelByte++);
  const idHex = bytesToHex(channelId);
  const group = channelGroupKey(root, channelId, 0);
  const stream = { epoch: 0n, group };
  const voice = { room: voiceGroupKey(root, channelId, 0), mediaKey: voiceMediaKey(root, channelId, 0) };
  return {
    channel: {
      id: channelId,
      idHex,
      name: "general",
      isPrivate: false,
      voice,
      streams: [stream],
      current: stream,
    },
    idHex,
  };
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

async function wrapChat(channel: ChannelV2, s: ReturnType<typeof signer>, content: string): Promise<NostrEvent> {
  const rumor = buildRumor({
    kind: KIND_MESSAGE,
    content,
    tags: [...channelBindingTags(channel.idHex, 0n)],
    pubkey: s.pubkey,
    ms: Date.now(),
  });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, s);
  return wrapSeal(seal, channel.current.group) as NostrEvent;
}

class FakeStore implements WireEventStore {
  events: NostrEvent[] = [];
  async event(ev: NostrEvent): Promise<void> {
    if (!this.events.some((e) => e.id === ev.id)) this.events.push(ev);
  }
}

function makeSinks(spec: Partial<WireSpec>, store = new FakeStore()) {
  const full: WireSpec = {
    subs: [],
    v2ByPk: new Map(),
    v1ByZ: new Map(),
    sig: "",
    ...spec,
  };
  return { store, sinks: { eventStore: Promise.resolve(store), getSpec: () => full } };
}

function plainEvent(kind: number, tags: string[][] = []): NostrEvent {
  return {
    id: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    kind,
    pubkey: "a".repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    content: "x",
    tags,
    sig: "",
  };
}

async function collectScopes(run: () => Promise<void>): Promise<Set<string>> {
  const seen = new Set<string>();
  const off = onWireScopes((scopes) => {
    for (const s of scopes) seen.add(s);
  });
  await run();
  // The bus coalesces on a 50ms window.
  await new Promise((r) => setTimeout(r, 120));
  off();
  return seen;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ingestWireEvents", () => {
  it("routes NIP-29 events to the store and announces the group scope", async () => {
    const { store, sinks } = makeSinks({});
    const ev = plainEvent(9, [["h", "g1"]]);

    const scopes = await collectScopes(() => ingestWireEvents(sinks, [ev]));

    expect(store.events).toHaveLength(1);
    expect(scopes.has("nip29:g1")).toBe(true);
  });

  it("routes kind-4 DMs to the store under the dm scope", async () => {
    const { store, sinks } = makeSinks({});
    const scopes = await collectScopes(() =>
      ingestWireEvents(sinks, [plainEvent(4, [["p", "f".repeat(64)]])]),
    );
    expect(store.events).toHaveLength(1);
    expect(scopes.has("dm")).toBe(true);
  });

  it("routes sealed V1 outers to the store, scoped by the z → channel map", async () => {
    const { store, sinks } = makeSinks({ v1ByZ: new Map([["z1", "chan1"]]) });
    const scopes = await collectScopes(() =>
      ingestWireEvents(sinks, [plainEvent(3300, [["z", "z1"]])]),
    );
    expect(store.events).toHaveLength(1);
    expect(scopes.has("c1:chan1")).toBe(true);
  });

  it("decrypts V2 wraps for held streams into the rumor store (never armada-events)", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const wrap = await wrapChat(channel, alice, "sealed hello");
    const { store, sinks } = makeSinks({ v2ByPk: new Map([[wrap.pubkey, channel]]) });

    const scopes = await collectScopes(() => ingestWireEvents(sinks, [wrap]));

    expect(store.events).toHaveLength(0); // wraps never land in armada-events
    expect(scopes.has(`c2:${idHex}`)).toBe(true);
    const rumors = await queryChannelRumors(idHex, { limit: 10 });
    expect(rumors.some((r) => r.content === "sealed hello")).toBe(true);
  });

  it("parks V2 wraps for streams we hold no key for and rings the park doorbell", async () => {
    const { channel } = makeChannel();
    const alice = signer();
    const wrap = await wrapChat(channel, alice, "not ours yet");
    const { store, sinks } = makeSinks({}); // empty v2ByPk — key unknown

    const scopes = await collectScopes(() => ingestWireEvents(sinks, [wrap]));

    expect(store.events).toHaveLength(0);
    // The park announces the wrap's STREAM ADDRESS, so a hook that holds the
    // key the wire's spec hasn't caught up to (post-rekey) can drain it.
    expect(scopes).toEqual(new Set([`c2park:${wrap.pubkey}`]));
    const parked = await peekPendingWraps([wrap.pubkey]);
    expect(parked.some((w) => w.id === wrap.id)).toBe(true);
  });

  it("skips malformed lines without dropping the rest of the batch", async () => {
    const { store, sinks } = makeSinks({});
    const good = plainEvent(9, [["h", "g1"]]);
    await ingestWireEvents(sinks, [
      { bogus: true } as unknown as NostrEvent,
      good,
    ]);
    expect(store.events.map((e) => e.id)).toEqual([good.id]);
  });
});

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

import { bytesToHex, channelGroupKey, controlGroupKey, voiceGroupKey, voiceMediaKey } from "@/concord-v2/lib/derive";
import { KIND_CONTROL, KIND_MESSAGE, KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT } from "@/concord-v2/lib/kinds";
import { peekPendingWraps, queryByStreams, queryChannelRumors } from "@/concord-v2/lib/rumorStore";
import { drainLiveDmWraps, resetLiveDmWraps } from "@/lib/nip17/dm17Store";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord-v2/lib/stream";
import type { ChannelV2 } from "@/concord-v2/lib/types";

import { onWireScopes, resetWireBus } from "./bus";
import { ingestWireEvents, type WireEventStore } from "./ingest";
import { registerNotifySink, type NotifyCandidate } from "./notify";
import type { WireSpec } from "./spec";

afterEach(() => {
  resetWireBus();
  resetLiveDmWraps();
});

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
    v2CommunityByChannel: new Map(),
    v2CtlByPk: new Map(),
    v1ByZ: new Map(),
    v1CtlByZ: new Map(),
    dm17ByPk: new Map(),
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

  it("routes a sealed V1 control edition to the store, scoped c1ctl:<community>", async () => {
    const { store, sinks } = makeSinks({ v1CtlByZ: new Map([["ctlZ", "comm1"]]) });
    const scopes = await collectScopes(() =>
      ingestWireEvents(sinks, [plainEvent(3308, [["z", "ctlZ"]])]),
    );
    expect(store.events).toHaveLength(1);
    expect(scopes.has("c1ctl:comm1")).toBe(true);
    expect(scopes.has("c1:ctlZ")).toBe(false);
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

  it("decrypts V2 control wraps into the opened-event store and rings the c2ctl fold-wake", async () => {
    const communityId = new Uint8Array(32).fill(200);
    const idHex = bytesToHex(communityId);
    const control = controlGroupKey(root, communityId, 0);
    const owner = signer();
    const rumor = buildRumor({
      kind: KIND_CONTROL,
      content: "edition",
      tags: [],
      pubkey: owner.pubkey,
      ms: Date.now(),
    });
    const wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, owner), control) as NostrEvent;
    const { store, sinks } = makeSinks({
      v2CtlByPk: new Map([[wrap.pubkey, { idHex, groups: [control] }]]),
    });

    const scopes = await collectScopes(() => ingestWireEvents(sinks, [wrap]));

    expect(store.events).toHaveLength(0); // wraps never land in armada-events
    expect(scopes.has(`c2ctl:${idHex}`)).toBe(true);
    const opened = await queryByStreams([control.pk]);
    expect(opened.some((o) => o.content === "edition")).toBe(true);
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

  it("buffers a live NIP-17 gift wrap addressed to the viewer and rings dm:wrap (not parked, not stored)", async () => {
    const self = "9".repeat(64);
    const { store, sinks } = makeSinks({});
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    // A kind-1059 gift wrap #p-tagged to the viewer (the wire's DM filter),
    // whose author is an unknown pubkey (ephemeral-key sender / bunker login,
    // so no dm17ByPk attribution).
    const wrap = plainEvent(1059, [["p", self]]);
    wrap.pubkey = "a".repeat(64);

    const scopes = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));

    expect(scopes.has("dm:wrap"), "a live DM wrap must wake useDm17").toBe(true);
    // The raw wrap is buffered in hand so useDm17 decrypts it WITHOUT a re-fetch.
    const buffered = drainLiveDmWraps();
    expect(buffered.map((w) => w.id)).toEqual([wrap.id]);
    // It must NOT be parked as a dead Concord V2 pending wrap, nor stored.
    expect(scopes.has(`c2park:${wrap.pubkey}`)).toBe(false);
    expect(store.events).toHaveLength(0);
    expect((await peekPendingWraps([wrap.pubkey]))).toHaveLength(0);
  });

  it("ignores a REPLAYED DM wrap: no re-buffer, no dm:wrap re-ring (the wrap filter's since rewind replays every round)", async () => {
    const self = "9".repeat(64);
    const { sinks } = makeSinks({});
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    const wrap = plainEvent(1059, [["p", self]]);
    wrap.pubkey = "a".repeat(64);

    // First delivery: buffered + doorbell. Drained by the DM hook.
    const first = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));
    expect(first.has("dm:wrap")).toBe(true);
    expect(drainLiveDmWraps().map((w) => w.id)).toEqual([wrap.id]);

    // A rotated round replays the same wrap: silence, nothing buffered.
    const replay = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));
    expect(replay.has("dm:wrap")).toBe(false);
    expect(drainLiveDmWraps()).toHaveLength(0);
  });

  it("still parks a kind-1059 wrap NOT addressed to the viewer (a genuine unknown V2 stream)", async () => {
    const self = "9".repeat(64);
    const { sinks } = makeSinks({});
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    const wrap = plainEvent(1059, [["p", "someone-else"]]);
    wrap.pubkey = "b".repeat(64);

    const scopes = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));

    expect(scopes.has("dm:wrap")).toBe(false);
    expect(drainLiveDmWraps()).toHaveLength(0); // nothing buffered
    expect(scopes.has(`c2park:${wrap.pubkey}`)).toBe(true);
    expect((await peekPendingWraps([wrap.pubkey])).some((w) => w.id === wrap.id)).toBe(true);
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

describe("ingestWireEvents — foreground notify candidates", () => {
  const SELF = "5".repeat(64);
  const PEER = "6".repeat(64);

  function withSink(spec: Partial<WireSpec>, self: string | undefined = SELF) {
    const captured: NotifyCandidate[] = [];
    const off = registerNotifySink((c) => captured.push(...c));
    const { sinks } = makeSinks(spec);
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    return { captured, off, sinks: withSelf };
  }

  it("emits a NIP-29 candidate with mention flag from a p-tag", async () => {
    const { captured, off, sinks } = withSink({});
    const ev = plainEvent(9, [["h", "g1"], ["p", SELF]]);
    ev.pubkey = PEER;
    try {
      await ingestWireEvents(sinks, [ev]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ plane: "nip29", groupId: "g1", mention: true, body: "x" });
  });

  it("never emits a candidate for the user's own message", async () => {
    const { captured, off, sinks } = withSink({});
    const ev = plainEvent(9, [["h", "g1"]]);
    ev.pubkey = SELF;
    try {
      await ingestWireEvents(sinks, [ev]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(0);
  });

  it("emits a DM candidate (mention=true) with no body preview (ciphertext)", async () => {
    const { captured, off, sinks } = withSink({});
    const ev = plainEvent(4, [["p", SELF]]);
    ev.pubkey = PEER;
    try {
      await ingestWireEvents(sinks, [ev]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ plane: "dm", peer: PEER, mention: true });
    expect(captured[0].body).toBeUndefined();
  });

  it("emits a c1 candidate keyed by the resolved channel id, no body/mention", async () => {
    const { captured, off, sinks } = withSink({ v1ByZ: new Map([["z1", "chan1"]]) });
    const ev = plainEvent(3300, [["z", "z1"]]);
    ev.pubkey = PEER;
    try {
      await ingestWireEvents(sinks, [ev]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      plane: "c1",
      v1ChannelIdHex: "chan1",
      roomKey: "z:z1",
      mention: false,
    });
    expect(captured[0].body).toBeUndefined();
  });

  it("emits a c2 candidate with the resolved community route", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const wrap = await wrapChat(channel, alice, "sealed hi");
    const { captured, off, sinks } = withSink({
      v2ByPk: new Map([[wrap.pubkey, channel]]),
      v2CommunityByChannel: new Map([[idHex, "comm-hex"]]),
    });
    try {
      await ingestWireEvents(sinks, [wrap]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      plane: "c2",
      channelIdHex: idHex,
      body: "sealed hi",
      path: `/c/comm-hex/${idHex}`,
    });
  });

  it("emits a DM candidate for a NIP-17 wrap whose author is a known conversation address", async () => {
    // A kind-1059 wrap from a follows-scoped conversation address (nips#2396).
    // The wire attributes it to the peer WITHOUT unwrapping, so mention=true,
    // no body, and — critically — it uses the ingest wall-clock time, not the
    // wrap's NIP-59-backdated created_at.
    const wrapPk = "a".repeat(64);
    const now = Math.floor(Date.now() / 1000);
    const wrap: NostrEvent = {
      id: "d".repeat(64),
      kind: 1059,
      pubkey: wrapPk,
      created_at: now - 2 * 24 * 60 * 60, // backdated 2 days (NIP-59)
      content: "sealed",
      tags: [["p", SELF]],
      sig: "",
    };
    const { captured, off, sinks } = withSink({ dm17ByPk: new Map([[wrapPk, PEER]]) });
    try {
      await ingestWireEvents(sinks, [wrap]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      plane: "dm",
      peer: PEER,
      author: PEER,
      mention: true,
      roomKey: `dm:${PEER}`,
      path: `/dms/${PEER}`,
    });
    expect(captured[0].body).toBeUndefined();
    // Live-stamped, not the backdated wrap time (which would trip the notifier's
    // session-floor / dedupe gates).
    expect(captured[0].createdAt).toBeGreaterThanOrEqual(now);
    // The wrap is NOT parked — useDm17 owns fetching/decrypting DM wraps.
    const parked = await peekPendingWraps([wrapPk]);
    expect(parked.some((w) => w.id === wrap.id)).toBe(false);
  });

  it("never emits a DM candidate for a REPLAYED NIP-17 wrap (live:false — pre-EOSE / APK drain)", async () => {
    // Candidates for DM wraps are wall-clock-stamped (the wrap's created_at is
    // backdated), so a replayed wrap would look brand-new to the notifier and
    // re-alert on every fresh round / relaunch. The wrap still buffers for the
    // decrypt path — only the notification is suppressed.
    const wrapPk = "a".repeat(64);
    const wrap: NostrEvent = {
      id: "f".repeat(64),
      kind: 1059,
      pubkey: wrapPk,
      created_at: Math.floor(Date.now() / 1000) - 3600,
      content: "sealed",
      tags: [["p", SELF]],
      sig: "",
    };
    const { captured, off, sinks } = withSink({ dm17ByPk: new Map([[wrapPk, PEER]]) });
    try {
      await ingestWireEvents(sinks, [wrap], { live: false });
    } finally {
      off();
    }
    expect(captured).toHaveLength(0);
    expect(drainLiveDmWraps().map((w) => w.id)).toEqual([wrap.id]);
  });

  it("never emits a DM candidate for our own self-copy wrap (author resolves to self)", async () => {
    const wrapPk = "b".repeat(64);
    const wrap: NostrEvent = {
      id: "e".repeat(64),
      kind: 1059,
      pubkey: wrapPk,
      created_at: Math.floor(Date.now() / 1000),
      content: "sealed",
      tags: [["p", SELF]],
      sig: "",
    };
    // A self-copy conversation address maps back to SELF.
    const { captured, off, sinks } = withSink({ dm17ByPk: new Map([[wrapPk, SELF]]) });
    try {
      await ingestWireEvents(sinks, [wrap]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(0);
  });
});

// @vitest-environment node
import { decrypt as nip44Decrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, it } from "vitest";

import { channelGroupKey, voiceGroupKey, voiceMediaKey, bytesToHex } from "./derive";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, openWrapToSeal } from "./stream";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "./kinds";
import type { Channel } from "./types";

const N = 400;

describe("decode cost breakdown", () => {
  it("measures each step per wrap", async () => {
    const root = new Uint8Array(32).fill(7);
    const channelId = new Uint8Array(32).fill(3);
    const group = channelGroupKey(root, channelId, 0);
    const streamKey = { epoch: 0n, group };
    const channel = {
      id: channelId, idHex: bytesToHex(channelId), name: "g", isPrivate: false,
      voice: { room: voiceGroupKey(root, channelId, 0), mediaKey: voiceMediaKey(root, channelId, 0) },
      streams: [streamKey], current: streamKey,
    } as unknown as Channel;
    const sk = generateSecretKey();
    const s = { pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
    const now = Math.floor(Date.now() / 1000);
    const wraps: NostrEvent[] = [];
    for (let i = 0; i < N; i++) {
      const rumor = buildRumor({ kind: KIND_MESSAGE, content: `message number ${i} with a bit of text to look like chat`, tags: [...channelBindingTags(channel.idHex, 0n)], pubkey: s.pubkey, ms: (now - i) * 1000 });
      const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, s);
      const w = wrapSeal(seal, group);
      wraps.push(finalizeEvent({ kind: w.kind, content: w.content, tags: w.tags, created_at: now - i }, group.sk));
    }
    const time = (label: string, fn: () => void) => {
      fn(); // warm
      const t = performance.now();
      for (let r = 0; r < 3; r++) fn();
      const per = (performance.now() - t) / 3 / N;
      console.log(`${label.padEnd(34)} ${(per * 1000).toFixed(1)} µs/wrap`);
      return per;
    };
    const seals = wraps.map((w) => JSON.parse(nip44Decrypt(w.content, group.convKey)) as NostrEvent);
    time("nip44 decrypt (wrap -> seal)", () => { for (const w of wraps) nip44Decrypt(w.content, group.convKey); });
    time("JSON.parse seal", () => { for (const w of seals) JSON.parse(JSON.stringify(w)); });
    time("nip44 decrypt (seal -> rumor)", () => { for (const x of seals) nip44Decrypt(x.content, group.convKey); });
    time("getEventHash (seal id)", () => { for (const x of seals) getEventHash(x); });
    time("schnorr.verify (seal sig)", () => { for (const x of seals) schnorr.verify(hexToBytes(x.sig), hexToBytes(x.id), hexToBytes(x.pubkey)); });
    time("verifyEvent nostr-tools (fresh obj)", () => { for (const x of seals) verifyEvent({ ...x }); });
    time("openWrapToSeal + finish (no verify)", () => { for (const w of wraps) openWrapToSeal(w, group).finish(); });
    const peers = seals.map(() => getPublicKey(generateSecretKey()));
    time("getConversationKey (ECDH, NIP-17 layer)", () => { for (const p of peers) getConversationKey(sk, p); });
    time("wrap signature verify (not done)", () => { for (const w of wraps) schnorr.verify(hexToBytes(w.sig), hexToBytes(w.id), hexToBytes(w.pubkey)); });
  }, 120_000);
});

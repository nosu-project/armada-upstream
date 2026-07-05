import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { openMessageMulti } from "@/concord-v1/lib/envelope";
import { createCommunity, type Channel } from "@/concord-v1/lib/types";
import {
  buildVoicePresenceInner,
  capVoiceServers,
  foldVoicePresence,
  rendezvousBroker,
  sealVoicePresence,
  signVoiceGrant,
  voiceMediaKey,
  voiceRoomName,
  VOICE_PRESENCE_STALE_MS,
} from "@/concord-v1/lib/voice";

function testChannel(): Channel {
  return createCommunity("Test", "general", []).channels[0];
}

/**
 * Seal a voice-presence announcement signed by `sk`, as a member would, pinned
 * to a controlled wall-clock `atMs` so staleness is testable.
 */
function presence(
  channel: Channel,
  sk: Uint8Array,
  status: "joined" | "left",
  atMs: number,
  broker?: string,
) {
  const template = buildVoicePresenceInner(channel, status, broker);
  template.created_at = Math.floor(atMs / 1000);
  template.tags = template.tags.map((t) => (t[0] === "ms" ? ["ms", String(atMs % 1000)] : t));
  const signed = finalizeEvent(template, sk);
  return sealVoicePresence(channel, signed);
}

describe("Concord voice room name + media key", () => {
  it("room name is the x-only pubkey of the voice signer (deterministic)", () => {
    const ch = testChannel();
    const name = voiceRoomName(ch);
    expect(name).toMatch(/^[0-9a-f]{64}$/);
    expect(voiceRoomName(ch)).toBe(name);
  });

  it("the self-signed grant is authored by the room name key", () => {
    const ch = testChannel();
    const { grant, roomName } = signVoiceGrant(ch, "https://broker.example");
    expect(grant.pubkey).toBe(roomName);
    expect(grant.kind).toBe(27235);
    expect(grant.tags.find((t) => t[0] === "room")?.[1]).toBe(roomName);
    expect(grant.tags.find((t) => t[0] === "u")?.[1]).toBe(
      `https://broker.example/.well-known/concord/voice/${roomName}`,
    );
  });

  it("room name + media key roll when the epoch advances", () => {
    const ch = testChannel();
    const next: Channel = { ...ch, epoch: ch.epoch + 1n };
    expect(voiceRoomName(next)).not.toBe(voiceRoomName(ch));
    expect(bytesToHex(voiceMediaKey(next))).not.toBe(bytesToHex(voiceMediaKey(ch)));
  });
});

describe("capVoiceServers", () => {
  it("dedupes, trims, and caps at 3", () => {
    expect(capVoiceServers([" a ", "a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
    expect(capVoiceServers([" ", ""])).toEqual([]);
  });
});

describe("voice presence (sealed kind-3306) round-trip + fold", () => {
  it("a joined presence is decryptable and folds to present (with broker hint)", () => {
    const ch = testChannel();
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const now = Date.now();
    const sealed = presence(ch, sk, "joined", now, "https://broker.example");

    const opened = openMessageMulti(sealed, ch.id, [{ epoch: ch.epoch, key: ch.key }]);
    expect(opened.author).toBe(pk);
    expect(foldVoicePresence([opened], now)).toEqual([{ pubkey: pk, broker: "https://broker.example" }]);
  });

  it("a left presence overrides an earlier joined", () => {
    const ch = testChannel();
    const sk = generateSecretKey();
    const t0 = Date.now();
    const joined = openMessageMulti(presence(ch, sk, "joined", t0), ch.id, [{ epoch: ch.epoch, key: ch.key }]);
    const left = openMessageMulti(presence(ch, sk, "left", t0 + 1000), ch.id, [{ epoch: ch.epoch, key: ch.key }]);
    expect(foldVoicePresence([joined, left], t0 + 1000)).toEqual([]);
  });

  it("a stale joined ages out", () => {
    const ch = testChannel();
    const sk = generateSecretKey();
    const t0 = Date.now();
    const opened = openMessageMulti(presence(ch, sk, "joined", t0), ch.id, [{ epoch: ch.epoch, key: ch.key }]);
    // Read far enough in the future that the presence is stale.
    expect(foldVoicePresence([opened], t0 + VOICE_PRESENCE_STALE_MS + 1)).toEqual([]);
  });

  it("a presence sealed under a different channel key is not decryptable", () => {
    const ch = testChannel();
    const other = testChannel();
    const sk = generateSecretKey();
    const sealed = presence(ch, sk, "joined", Date.now());
    expect(() =>
      openMessageMulti(sealed, ch.id, [{ epoch: other.epoch, key: other.key }]),
    ).toThrow();
  });
});

describe("rendezvousBroker", () => {
  it("returns undefined for an empty room (caller uses its own preference)", () => {
    expect(rendezvousBroker([])).toBeUndefined();
    expect(rendezvousBroker([{ pubkey: "a" }])).toBeUndefined();
  });

  it("returns the single broker people are on", () => {
    expect(rendezvousBroker([{ pubkey: "a", broker: "https://x" }])).toBe("https://x");
  });

  it("deterministically tiebreaks a split to the smallest origin", () => {
    const present = [
      { pubkey: "a", broker: "https://beta.example" },
      { pubkey: "b", broker: "https://alpha.example" },
    ];
    expect(rendezvousBroker(present)).toBe("https://alpha.example");
    // Order-independent.
    expect(rendezvousBroker([...present].reverse())).toBe("https://alpha.example");
  });
});

import { bytesToHex } from "@noble/hashes/utils.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  buildChannelRekeyEvent,
  buildServerRootRekeyEvent,
  buildRekeyBlob,
  epochKeyCommitment,
  openRekeyBlob,
  openRekeyEvent,
  type RekeyBlob,
} from "@/concord-v1/lib/rekey";
import { random32 } from "@/concord-v1/lib/types";

// Rekey EVENT layer + the ban read-cut scenario (Phase 4 of Vector parity).

describe("rekey event (3303) channel rotation", () => {
  it("rotates a channel: a recipient recovers the new key; an excluded member does not", () => {
    const rotatorSk = generateSecretKey();
    const stay = generateSecretKey();
    const banned = generateSecretKey();
    const serverRoot = random32();
    const channelId = random32();
    const prevKey = random32();
    const prevEpoch = 0n;
    const newEpoch = 1n;
    const newKey = random32();

    // Blobs only to the staying member (banned excluded — the read-cut).
    const blobs: RekeyBlob[] = [
      buildRekeyBlob(rotatorSk, getPublicKey(stay), { kind: "channel", channelId }, newEpoch, newKey),
    ];
    const event = buildChannelRekeyEvent({
      rotatorSk,
      serverRoot,
      channelId,
      newEpoch,
      prevEpoch,
      prevKeyCommitment: epochKeyCommitment(prevEpoch, prevKey),
      blobs,
    });

    // Any member opens the outer with the server-root key (stable).
    const parsed = openRekeyEvent(event, serverRoot);
    expect(parsed.rotator).toBe(getPublicKey(rotatorSk));
    expect(parsed.scope.kind).toBe("channel");
    expect(parsed.newEpoch).toBe(newEpoch);
    expect(bytesToHex(parsed.prevKeyCommitment)).toBe(bytesToHex(epochKeyCommitment(prevEpoch, prevKey)));

    // The staying member recovers the new key from their blob.
    const recovered = openRekeyBlob(stay, parsed.rotator, parsed.scope, parsed.newEpoch, parsed.blobs[0]);
    expect(bytesToHex(recovered)).toBe(bytesToHex(newKey));

    // The banned member finds the event (it's there) but recovers NO key —
    // every blob fails to open for them.
    for (const blob of parsed.blobs) {
      expect(() => openRekeyBlob(banned, parsed.rotator, parsed.scope, parsed.newEpoch, blob)).toThrow();
    }
  });

  it("a wrong server-root key can't even open the outer (non-member)", () => {
    const rotatorSk = generateSecretKey();
    const serverRoot = random32();
    const channelId = random32();
    const event = buildChannelRekeyEvent({
      rotatorSk,
      serverRoot,
      channelId,
      newEpoch: 1n,
      prevEpoch: 0n,
      prevKeyCommitment: epochKeyCommitment(0n, random32()),
      blobs: [],
    });
    expect(() => openRekeyEvent(event, random32())).toThrow();
  });
});

describe("rekey event (3303) server-root rotation", () => {
  it("rotates the base: a recipient recovers the new root via a ServerRoot blob", () => {
    const rotatorSk = generateSecretKey();
    const stay = generateSecretKey();
    const priorRoot = random32();
    const communityId = random32();
    const newRoot = random32();

    const blobs = [buildRekeyBlob(rotatorSk, getPublicKey(stay), { kind: "server-root" }, 1n, newRoot)];
    const event = buildServerRootRekeyEvent({
      rotatorSk,
      priorRoot,
      communityId,
      newEpoch: 1n,
      prevEpoch: 0n,
      prevKeyCommitment: epochKeyCommitment(0n, priorRoot),
      blobs,
    });

    // Opened with the PRIOR root (the handle every current member holds).
    const parsed = openRekeyEvent(event, priorRoot);
    expect(parsed.scope.kind).toBe("server-root");
    const recovered = openRekeyBlob(stay, parsed.rotator, { kind: "server-root" }, 1n, parsed.blobs[0]);
    expect(bytesToHex(recovered)).toBe(bytesToHex(newRoot));
  });
});

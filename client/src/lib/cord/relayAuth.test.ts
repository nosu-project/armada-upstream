/**
 * CORD stream NIP-42 auth ("AUTH as the room") — registry + challenge tests.
 *
 * The contract under test: every registered stream key answers a relay's
 * NIP-42 challenge with a valid kind-22242 AUTH frame signed BY THE STREAM
 * KEY; late registrations auth immediately against a live challenge; a
 * re-issued identical challenge never double-sends; a fresh challenge
 * (reconnect) re-auths everything.
 */

import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";

import {
  onCordAuthChallenge,
  registerCordStreamKeys,
  resetCordStreamAuth,
  type StreamAuthKey,
} from "@/lib/cord/relayAuth";

const RELAY = "wss://relay.example.com";

function key(): StreamAuthKey {
  const sk = generateSecretKey();
  return { pk: getPublicKey(sk), sk };
}

/** Collects AUTH frames the module "sends", parsed back to events. */
function sink(): { frames: NostrEvent[]; send: (frame: string) => void } {
  const frames: NostrEvent[] = [];
  return {
    frames,
    send: (frame: string) => {
      const msg = JSON.parse(frame) as [string, NostrEvent];
      expect(msg[0]).toBe("AUTH");
      frames.push(msg[1]);
    },
  };
}

afterEach(() => resetCordStreamAuth());

describe("cord relay auth (AUTH as the room)", () => {
  it("answers a challenge with one valid kind-22242 per registered stream key", () => {
    const a = key();
    const b = key();
    registerCordStreamKeys([RELAY], [a, b]);

    const s = sink();
    onCordAuthChallenge(RELAY, "challenge-1", s.send);

    expect(s.frames).toHaveLength(2);
    expect(new Set(s.frames.map((e) => e.pubkey))).toEqual(new Set([a.pk, b.pk]));
    for (const ev of s.frames) {
      expect(ev.kind).toBe(22242);
      expect(verifyEvent(ev)).toBe(true);
      expect(ev.tags).toContainEqual(["relay", RELAY]);
      expect(ev.tags).toContainEqual(["challenge", "challenge-1"]);
    }
  });

  it("auths a late-registered key immediately against the live challenge", () => {
    const s = sink();
    onCordAuthChallenge(RELAY, "challenge-1", s.send);
    expect(s.frames).toHaveLength(0); // nothing registered yet

    const a = key();
    registerCordStreamKeys([RELAY], [a]);
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0].pubkey).toBe(a.pk);
    expect(s.frames[0].tags).toContainEqual(["challenge", "challenge-1"]);
  });

  it("never double-sends for a re-issued identical challenge, re-auths all on a fresh one", () => {
    const a = key();
    registerCordStreamKeys([RELAY], [a]);

    const s = sink();
    onCordAuthChallenge(RELAY, "challenge-1", s.send);
    onCordAuthChallenge(RELAY, "challenge-1", s.send); // REQ-retry re-issue
    expect(s.frames).toHaveLength(1);

    onCordAuthChallenge(RELAY, "challenge-2", s.send); // reconnect
    expect(s.frames).toHaveLength(2);
    expect(s.frames[1].tags).toContainEqual(["challenge", "challenge-2"]);
  });

  it("registration is idempotent and scoped per relay", () => {
    const a = key();
    registerCordStreamKeys([RELAY], [a]);
    registerCordStreamKeys([RELAY], [a]); // duplicate — free

    const s1 = sink();
    onCordAuthChallenge(RELAY, "c", s1.send);
    expect(s1.frames).toHaveLength(1);

    // A different relay with no registered keys sends nothing.
    const s2 = sink();
    onCordAuthChallenge("wss://other.example.com", "c", s2.send);
    expect(s2.frames).toHaveLength(0);
  });

  it("normalizes relay URLs so registration and challenge keys match", () => {
    const a = key();
    registerCordStreamKeys([`${RELAY}/`], [a]); // trailing slash

    const s = sink();
    onCordAuthChallenge(RELAY, "c", s.send); // no slash
    expect(s.frames).toHaveLength(1);
  });
});

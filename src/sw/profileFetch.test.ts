import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchProfiles } from "./profileFetch";

import type { NostrEvent } from "@nostrify/nostrify";

/** A relay socket that answers its REQ from `answers[url]`, then EOSEs. */
function stubRelays(answers: Record<string, NostrEvent[]>) {
  const opened: string[] = [];
  class FakeSocket {
    onopen?: () => void;
    onmessage?: (message: { data: string }) => void;
    onerror?: () => void;
    onclose?: () => void;
    constructor(readonly url: string) {
      opened.push(url);
      queueMicrotask(() => this.onopen?.());
    }
    send(raw: string) {
      const [, subId] = JSON.parse(raw);
      queueMicrotask(() => {
        for (const ev of answers[this.url] ?? []) {
          this.onmessage?.({ data: JSON.stringify(["EVENT", subId, ev]) });
        }
        this.onmessage?.({ data: JSON.stringify(["EOSE", subId]) });
      });
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  return opened;
}

function profile(sk: Uint8Array, name: string, createdAt = Math.floor(Date.now() / 1000)) {
  return finalizeEvent({ kind: 0, content: JSON.stringify({ name }), tags: [], created_at: createdAt }, sk);
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchProfiles", () => {
  it("returns the newest valid kind 0 per pubkey across relays", async () => {
    const sk = generateSecretKey();
    stubRelays({
      "wss://a.example": [profile(sk, "old", 100)],
      "wss://b.example": [profile(sk, "new", 200)],
    });
    const found = await fetchProfiles(["wss://a.example", "wss://b.example"], [getPublicKey(sk)]);
    expect(found.map((ev) => JSON.parse(ev.content).name)).toEqual(["new"]);
  });

  it("drops forged events and profiles nobody asked for", async () => {
    const sk = generateSecretKey();
    const forged = { ...profile(sk, "real"), content: JSON.stringify({ name: "forged" }) };
    stubRelays({ "wss://a.example": [forged, profile(generateSecretKey(), "stranger")] });
    expect(await fetchProfiles(["wss://a.example"], [getPublicKey(sk)])).toEqual([]);
  });

  it("asks at most four relays, and only websocket ones", async () => {
    const opened = stubRelays({});
    await fetchProfiles(
      ["https://x.example", "wss://1.example", "wss://2.example", "wss://3.example", "wss://4.example", "wss://5.example"],
      [getPublicKey(generateSecretKey())],
    );
    expect(opened).toEqual(["wss://1.example", "wss://2.example", "wss://3.example", "wss://4.example"]);
  });

  it("gives up at the timeout rather than waiting on a silent relay", async () => {
    vi.stubGlobal("WebSocket", class { send() {} close() {} });
    vi.useFakeTimers();
    try {
      const pending = fetchProfiles(["wss://silent.example"], [getPublicKey(generateSecretKey())], 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

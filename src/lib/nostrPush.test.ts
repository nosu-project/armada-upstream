import { describe, expect, it } from "vitest";

import {
  KIND_PUSH_RPC,
  NostrPushClient,
  NostrPushError,
  type PushRelayPool,
  type PushSigner,
} from "@/lib/nostrPush";
import type { NostrEvent } from "@nostrify/types";

const SERVER = "server".padEnd(64, "0");
const ME = "me".padEnd(64, "0");
const REQ_ID = "fixed-request-id";

/**
 * Passthrough NIP-44 signer: encrypt/decrypt are identity so the test can read
 * and craft plaintext JSON on the wire. signEvent echoes the template.
 */
function fakeSigner(): PushSigner {
  return {
    getPublicKey: async () => ME,
    signEvent: async (t) => ({
      ...t,
      id: "id",
      pubkey: ME,
      sig: "sig",
    }) as unknown as NostrEvent,
    nip44: {
      encrypt: async (_pk, plaintext) => plaintext,
      decrypt: async (_pk, ciphertext) => ciphertext,
    },
  };
}

/** A pool whose REQ replays `msgs` then closes; records published events. */
function fakePool(
  msgs: (string | NostrEvent)[][],
  published: NostrEvent[] = [],
): PushRelayPool {
  return {
    relay: () => ({
      event: async (event) => {
        published.push(event);
      },
      req: async function* () {
        for (const m of msgs) yield m;
      },
    }),
  };
}

/** A kind-25742 reply event carrying `response` as (passthrough) plaintext. */
function replyEvent(response: unknown): NostrEvent {
  return {
    kind: KIND_PUSH_RPC,
    pubkey: SERVER,
    content: JSON.stringify(response),
    tags: [["p", ME]],
    created_at: 0,
    id: "reply",
    sig: "sig",
  } as NostrEvent;
}

function makeClient(pool: PushRelayPool, relays = ["wss://push"]) {
  return new NostrPushClient({
    serverPubkey: SERVER,
    relays,
    signer: fakeSigner(),
    pool,
    uuid: () => REQ_ID,
    timeoutMs: 200,
  });
}

describe("NostrPushClient", () => {
  it("returns the VAPID key from a matching reply", async () => {
    const reply = replyEvent({
      request_id: REQ_ID,
      success: true,
      result: { vapid_public_key: "VKEY" },
    });
    const key = await makeClient(fakePool([["EVENT", "s", reply]])).getVapidKey("armada.buzz");
    expect(key).toBe("VKEY");
  });

  it("publishes a signed, p-tagged kind-25742 request", async () => {
    const published: NostrEvent[] = [];
    const reply = replyEvent({ request_id: REQ_ID, success: true, result: { success: true } });
    const pool = fakePool([["EVENT", "s", reply]], published);
    await makeClient(pool).registerSubscription({
      subscription_id: "armada-groups",
      domain: "armada.buzz",
      filter: { kinds: [9] },
      notification: { title: "t", body: "b" },
      push_subscription: { type: "web", endpoint: "https://x", p256dh_key: "p", auth_key: "a" },
    });
    expect(published).toHaveLength(1);
    expect(published[0].kind).toBe(KIND_PUSH_RPC);
    expect(published[0].tags).toContainEqual(["p", SERVER]);
  });

  it("throws NostrPushError on an error reply", async () => {
    const reply = replyEvent({ request_id: REQ_ID, success: false, error: "quota exceeded" });
    await expect(
      makeClient(fakePool([["EVENT", "s", reply]])).deleteSubscription("x", "armada.buzz"),
    ).rejects.toThrow(/quota exceeded/);
  });

  it("ignores replies with a mismatched request_id, then times out", async () => {
    const other = replyEvent({ request_id: "someone-else", success: true, result: {} });
    await expect(
      makeClient(fakePool([["EVENT", "s", other]])).getVapidKey("armada.buzz"),
    ).rejects.toThrow(NostrPushError);
  });

  it("times out when no reply arrives", async () => {
    await expect(makeClient(fakePool([])).getVapidKey("armada.buzz")).rejects.toThrow(
      /timed out/,
    );
  });

  it("resolves from whichever relay answers first", async () => {
    const reply = replyEvent({
      request_id: REQ_ID,
      success: true,
      result: { vapid_public_key: "VKEY" },
    });
    // First relay stays silent; second delivers.
    const pool: PushRelayPool = {
      relay: (url) => ({
        event: async () => {},
        req: async function* () {
          if (url === "wss://b") yield ["EVENT", "s", reply];
        },
      }),
    };
    const key = await makeClient(pool, ["wss://a", "wss://b"]).getVapidKey("armada.buzz");
    expect(key).toBe("VKEY");
  });

  it("refuses to run without a NIP-44 signer", async () => {
    const signer: PushSigner = {
      getPublicKey: async () => ME,
      signEvent: async () => ({}) as NostrEvent,
    };
    const client = new NostrPushClient({
      serverPubkey: SERVER,
      relays: ["wss://push"],
      signer,
      pool: fakePool([]),
      uuid: () => REQ_ID,
      timeoutMs: 200,
    });
    await expect(client.getVapidKey("armada.buzz")).rejects.toThrow(/NIP-44/);
  });
});

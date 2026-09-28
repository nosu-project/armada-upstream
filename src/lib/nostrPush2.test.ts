import { NSecSigner } from "@nostrify/nostrify";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { beforeEach, describe, expect, it } from "vitest";

import {
  base64urlToBytes,
  isUnknownClientError,
  KIND_NOSTR_PUSH2_RPC,
  loadNostrPush2Identity,
  NostrPush2Client,
} from "@/lib/nostrPush2";

import type { NostrEvent, NostrFilter } from "@nostrify/types";
import type { PushRelayPool } from "@/lib/nostrPush";

/**
 * One relay with a nostr-push2 service on it: requests addressed to the
 * service are decrypted and answered by `handle`, and the answer is delivered
 * to whichever REQ is listening for it.
 */
function fakeService(handle: (method: string, params: unknown, client: string) => unknown) {
  const serviceSk = generateSecretKey();
  const service = new NSecSigner(serviceSk);
  const servicePubkey = getPublicKey(serviceSk);
  const listeners = new Set<(event: NostrEvent) => void>();
  const requests: Array<{ method: string; params: unknown; pubkey: string }> = [];

  const pool: PushRelayPool = {
    relay: () => ({
      async event(event) {
        expect(event.kind).toBe(KIND_NOSTR_PUSH2_RPC);
        expect(event.tags).toEqual([["p", servicePubkey]]);
        const request = JSON.parse(await service.nip44.decrypt(event.pubkey, event.content));
        requests.push({ method: request.method, params: request.params, pubkey: event.pubkey });
        let body: Record<string, unknown>;
        try {
          body = { id: request.id, result: handle(request.method, request.params, event.pubkey) };
        } catch (err) {
          body = { id: request.id, error: (err as Error).message };
        }
        const response = await service.signEvent({
          kind: KIND_NOSTR_PUSH2_RPC,
          content: await service.nip44.encrypt(event.pubkey, JSON.stringify(body)),
          tags: [["p", event.pubkey]],
          created_at: Math.floor(Date.now() / 1000),
        });
        for (const listener of listeners) listener(response);
      },
      async *req(filters: NostrFilter[], opts?: { signal?: AbortSignal }) {
        const queue: NostrEvent[] = [];
        let wake: (() => void) | undefined;
        const listener = (event: NostrEvent) => {
          if (!filters.some((f) => f["#p"]?.includes(event.tags[0][1]))) return;
          queue.push(event);
          wake?.();
        };
        listeners.add(listener);
        try {
          while (!opts?.signal?.aborted) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
                opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
              continue;
            }
            yield ["EVENT", "sub", queue.shift()!];
          }
        } finally {
          listeners.delete(listener);
        }
      },
    }),
  };

  return { pool, servicePubkey, requests };
}

describe("NostrPush2Client", () => {
  it("speaks the RPC with the install's own key, never the account's", async () => {
    const { pool, servicePubkey, requests } = fakeService((method) =>
      method === "get" ? { subscriptions: [{ filters: [{ kinds: [1] }], relays: ["wss://r"] }] } : {});
    const secretKey = generateSecretKey();
    const client = new NostrPush2Client({ servicePubkey, relays: ["wss://r"], secretKey, pool });

    await client.create({
      method: "web",
      endpoint: "https://push.example/abc",
      p256dh: "p",
      auth: "a",
      vapid_private_key: "d",
    });
    await client.set([{ filters: [{ kinds: [1] }], relays: ["wss://r"] }]);
    await expect(client.get()).resolves.toEqual([{ filters: [{ kinds: [1] }], relays: ["wss://r"] }]);

    expect(requests.map((r) => r.method)).toEqual(["create", "set", "get"]);
    expect(requests.every((r) => r.pubkey === getPublicKey(secretKey))).toBe(true);
    expect(requests[1].params).toEqual({ subscriptions: [{ filters: [{ kinds: [1] }], relays: ["wss://r"] }] });
    expect(requests[2].params).toBeUndefined();
  });

  it("rejects with the service's error, and recognizes a forgotten client", async () => {
    const { pool, servicePubkey } = fakeService(() => {
      throw new Error("unknown client; call create first");
    });
    const client = new NostrPush2Client({
      servicePubkey,
      relays: ["wss://r"],
      secretKey: generateSecretKey(),
      pool,
    });

    const err = await client.set([]).catch((e: unknown) => e);
    expect((err as Error).message).toBe("unknown client; call create first");
    expect(isUnknownClientError(err)).toBe(true);
  });

  it("gives up when nobody answers", async () => {
    const pool: PushRelayPool = {
      relay: () => ({
        event: async () => {},
        async *req(_filters, opts) {
          await new Promise<void>((resolve) => opts?.signal?.addEventListener("abort", () => resolve()));
          yield* [];
        },
      }),
    };
    const client = new NostrPush2Client({
      servicePubkey: getPublicKey(generateSecretKey()),
      relays: ["wss://r"],
      secretKey: generateSecretKey(),
      pool,
      timeoutMs: 20,
    });
    await expect(client.ping()).rejects.toThrow("did not answer");
  });
});

describe("loadNostrPush2Identity", () => {
  beforeEach(() => localStorage.clear());

  it("mints a client key and a P-256 VAPID key once, then keeps them", async () => {
    const first = await loadNostrPush2Identity();
    expect(first.secretKey).toHaveLength(32);
    expect(base64urlToBytes(first.vapidPublicKey)).toHaveLength(65);
    expect(base64urlToBytes(first.vapidPrivateKey)).toHaveLength(32);

    const second = await loadNostrPush2Identity();
    expect(second.vapidPublicKey).toBe(first.vapidPublicKey);
    expect(second.vapidPrivateKey).toBe(first.vapidPrivateKey);
    expect([...second.secretKey]).toEqual([...first.secretKey]);
  });
});

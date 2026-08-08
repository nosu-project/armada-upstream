import { describe, expect, it } from "vitest";

import { NSecSigner } from "@nostrify/nostrify";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { generateSecretKey, getPublicKey } from "nostr-tools";

import { Nip46Signer } from "@/lib/nip46Signer";
import type { Nip46Transport } from "@/lib/nip46Transport";

type RelayMsg = ["EVENT", string, NostrEvent];

/**
 * In-memory stand-in for Nip46Transport: same req/event surface, no sockets.
 * `emit` delivers an inbound event to every live subscription (like a relay
 * would); `published` records every outbound request event.
 */
function makeFakeTransport() {
  const published: NostrEvent[] = [];
  const listeners = new Set<(event: NostrEvent) => void>();
  let onPublish: ((event: NostrEvent) => void) | undefined;

  const transport = {
    published,
    emit(event: NostrEvent) {
      for (const l of [...listeners]) l(event);
    },
    setOnPublish(fn: (event: NostrEvent) => void) {
      onPublish = fn;
    },
    req(_filters: NostrFilter[], opts?: { signal?: AbortSignal }) {
      const queue: RelayMsg[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const listener = (event: NostrEvent) => {
        queue.push(["EVENT", "sub", event]);
        wake?.();
      };
      listeners.add(listener);
      const end = () => {
        if (ended) return;
        ended = true;
        listeners.delete(listener);
        wake?.();
      };
      opts?.signal?.addEventListener("abort", end, { once: true });
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<RelayMsg> {
          try {
            for (;;) {
              while (queue.length > 0) yield queue.shift()!;
              if (ended) return;
              await new Promise<void>((r) => {
                wake = r;
              });
              wake = undefined;
            }
          } finally {
            end();
          }
        },
      };
    },
    async event(event: NostrEvent, _opts?: { signal?: AbortSignal }) {
      published.push(event);
      onPublish?.(event);
    },
  };
  return transport;
}

type FakeTransport = ReturnType<typeof makeFakeTransport>;

interface BunkerRequest {
  id: string;
  method: string;
  params: string[];
}

/**
 * Wire a virtual remote signer to the fake transport. `handler` receives
 * each decrypted request and returns the response payload (`{ result }` or
 * `{ error }`), or `null` to stay silent (simulating a lost request).
 * Responses are NIP-44 encrypted unless `legacyNip04` is set.
 */
function attachBunker(
  transport: FakeTransport,
  handler: (req: BunkerRequest) => Promise<{ result?: string; error?: string } | null>,
  opts?: { legacyNip04?: boolean },
) {
  const bunkerSigner = new NSecSigner(bunkerSk);
  const clientPubkey = getPublicKey(clientSk);

  transport.setOnPublish((event) => {
    void (async () => {
      const req = JSON.parse(await bunkerSigner.nip44.decrypt(clientPubkey, event.content)) as BunkerRequest;
      const out = await handler(req);
      if (!out) return;
      const payload = JSON.stringify({ id: req.id, ...out });
      const content = opts?.legacyNip04
        ? await bunkerSigner.nip04.encrypt(clientPubkey, payload)
        : await bunkerSigner.nip44.encrypt(clientPubkey, payload);
      const responseEvent = await bunkerSigner.signEvent({
        kind: 24133,
        content,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", clientPubkey]],
      });
      transport.emit(responseEvent);
    })();
  });

  return bunkerSigner;
}

const clientSk = generateSecretKey();
const bunkerSk = generateSecretKey();
const bunkerPubkey = getPublicKey(bunkerSk);

function makeSigner(transport: FakeTransport, opts?: { attemptTimeoutMs?: number; attempts?: number }) {
  return new Nip46Signer({
    transport: transport as unknown as Nip46Transport,
    bunkerPubkey,
    clientSigner: new NSecSigner(clientSk),
    attemptTimeoutMs: opts?.attemptTimeoutMs ?? 200,
    attempts: opts?.attempts ?? 2,
  });
}

const pendingSize = (s: Nip46Signer) =>
  (s as unknown as { pending: Map<string, unknown> }).pending.size;

describe("Nip46Signer", () => {
  it("round-trips sign_event through the bunker", async () => {
    const transport = makeFakeTransport();
    attachBunker(transport, async (req) => {
      expect(req.method).toBe("sign_event");
      const signed = await new NSecSigner(bunkerSk).signEvent(
        JSON.parse(req.params[0]) as Omit<NostrEvent, "id" | "pubkey" | "sig">,
      );
      return { result: JSON.stringify(signed) };
    });
    const signer = makeSigner(transport);

    const event = await signer.signEvent({
      kind: 1,
      content: "hello",
      tags: [],
      created_at: 1_700_000_000,
    });

    expect(event.pubkey).toBe(getPublicKey(bunkerSk));
    expect(event.content).toBe("hello");
    expect(typeof event.sig).toBe("string");
    expect(transport.published).toHaveLength(1);
    expect(pendingSize(signer)).toBe(0);
  });

  it("matches concurrent responses to their requests by id", async () => {
    const transport = makeFakeTransport();
    attachBunker(transport, async (req) => {
      // Answer the SECOND request first: hold the slow one back.
      if (req.params[1] === "slow") await new Promise((r) => setTimeout(r, 50));
      return { result: `decrypted:${req.params[1]}` };
    });
    // An attempt timeout the 50ms hold cannot trip. At the 200ms default, a
    // loaded box pushed the slow leg past the deadline, the signer republished
    // it, and the published count below saw 3 — a retry this test never meant
    // to exercise (that path has its own tests). Only the id-matching matters
    // here, so take the retry out of the picture rather than race it.
    const signer = makeSigner(transport, { attemptTimeoutMs: 30_000 });

    const [slow, fast] = await Promise.all([
      signer.nip44.decrypt("aa".repeat(32), "slow"),
      signer.nip44.decrypt("aa".repeat(32), "fast"),
    ]);

    expect(slow).toBe("decrypted:slow");
    expect(fast).toBe("decrypted:fast");
    expect(transport.published).toHaveLength(2);
    expect(pendingSize(signer)).toBe(0);
  });

  it("decrypts legacy NIP-04 responses", async () => {
    const transport = makeFakeTransport();
    attachBunker(transport, async () => ({ result: "pong" }), { legacyNip04: true });
    const signer = makeSigner(transport);

    await expect(signer.ping()).resolves.toBe("pong");
  });

  it("republishes a fresh request when an attempt goes unanswered", async () => {
    const transport = makeFakeTransport();
    let calls = 0;
    attachBunker(transport, async () => {
      calls++;
      if (calls === 1) return null; // first request "lost"
      return { result: "recovered" };
    });
    const signer = makeSigner(transport);

    await expect(signer.ping()).resolves.toBe("recovered");
    expect(transport.published).toHaveLength(2);
    expect(transport.published[0].id).not.toBe(transport.published[1].id);
    expect(pendingSize(signer)).toBe(0);
  });

  it("fails after all attempts when the bunker stays silent", async () => {
    const transport = makeFakeTransport();
    attachBunker(transport, async () => null);
    const signer = makeSigner(transport, { attemptTimeoutMs: 150, attempts: 2 });

    await expect(signer.ping()).rejects.toThrow(/timed out/);
    expect(transport.published).toHaveLength(2);
    expect(pendingSize(signer)).toBe(0);
  });

  it("does NOT retry an explicit bunker error (no double prompts)", async () => {
    const transport = makeFakeTransport();
    let calls = 0;
    attachBunker(transport, async () => {
      calls++;
      return { error: "user rejected" };
    });
    const signer = makeSigner(transport, { attempts: 2 });

    await expect(signer.ping()).rejects.toThrow("user rejected");
    expect(calls).toBe(1);
    expect(transport.published).toHaveLength(1);
    expect(pendingSize(signer)).toBe(0);
  });

  it("ignores stale responses for already-settled requests", async () => {
    const transport = makeFakeTransport();
    const bunkerSigner = new NSecSigner(bunkerSk);
    const clientPubkey = getPublicKey(clientSk);
    attachBunker(transport, async (_req) => ({ result: "ok" }));
    const signer = makeSigner(transport);

    await expect(signer.ping()).resolves.toBe("ok");

    // A duplicate/late response with an unknown id must not throw or leak.
    const stale = await bunkerSigner.signEvent({
      kind: 24133,
      content: await bunkerSigner.nip44.encrypt(
        clientPubkey,
        JSON.stringify({ id: "nobody-is-waiting-for-this", result: "ok" }),
      ),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", clientPubkey]],
    });
    transport.emit(stale);
    await new Promise((r) => setTimeout(r, 20));
    expect(pendingSize(signer)).toBe(0);
  });

  it("maps sign_psbt capability errors to the unsupported message", async () => {
    const transport = makeFakeTransport();
    attachBunker(transport, async () => ({ error: "unknown method" }));
    const signer = makeSigner(transport);

    await expect(signer.signPsbt("70736274ff")).rejects.toThrow(/doesn't support sending Bitcoin/);
  });
});

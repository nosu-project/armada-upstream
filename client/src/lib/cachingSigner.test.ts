import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wrapSignerWithDecryptCache } from "@/lib/cachingSigner";
import { __resetDecryptCacheForTests } from "@/lib/decryptCache";

import type { NostrSigner } from "@nostrify/nostrify";

const USER = "a".repeat(64);
const PEER = "b".repeat(64);

beforeEach(async () => {
  await __resetDecryptCacheForTests();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("armada-decrypt-cache");
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  await __resetDecryptCacheForTests();
});

afterEach(async () => {
  await __resetDecryptCacheForTests();
});

/** A minimal fake signer with spy-able nip04/nip44 + encrypt/sign. */
function makeSigner() {
  const nip44Decrypt = vi.fn(async (_p: string, ct: string) => `plain:${ct}`);
  const nip04Decrypt = vi.fn(async (_p: string, ct: string) => `legacy:${ct}`);
  const encrypt = vi.fn(async (_p: string, pt: string) => `ct:${pt}`);
  const signEvent = vi.fn(async (t: unknown) => ({ ...(t as object), id: "x", pubkey: USER, sig: "s" }));
  const signer = {
    getPublicKey: vi.fn(async () => USER),
    signEvent,
    nip04: { encrypt, decrypt: nip04Decrypt },
    nip44: { encrypt, decrypt: nip44Decrypt },
  } as unknown as NostrSigner;
  return { signer, nip44Decrypt, nip04Decrypt, encrypt, signEvent };
}

describe("wrapSignerWithDecryptCache", () => {
  it("calls upstream decrypt once, then serves from the persistent cache", async () => {
    const { signer, nip44Decrypt } = makeSigner();
    const wrapped = wrapSignerWithDecryptCache(signer, USER);

    const a = await wrapped.nip44!.decrypt(PEER, "CIPHER");
    const b = await wrapped.nip44!.decrypt(PEER, "CIPHER");

    expect(a).toBe("plain:CIPHER");
    expect(b).toBe("plain:CIPHER");
    expect(nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it("survives a fresh wrapper (cache is persistent, not per-instance)", async () => {
    const first = makeSigner();
    await wrapSignerWithDecryptCache(first.signer, USER).nip44!.decrypt(PEER, "CIPHER");
    expect(first.nip44Decrypt).toHaveBeenCalledTimes(1);

    // A brand new signer + wrapper (e.g. after a reload) must hit the cache.
    const second = makeSigner();
    const val = await wrapSignerWithDecryptCache(second.signer, USER).nip44!.decrypt(PEER, "CIPHER");
    expect(val).toBe("plain:CIPHER");
    expect(second.nip44Decrypt).not.toHaveBeenCalled();
  });

  it("caches nip04 and nip44 independently", async () => {
    const { signer, nip04Decrypt, nip44Decrypt } = makeSigner();
    const wrapped = wrapSignerWithDecryptCache(signer, USER);

    expect(await wrapped.nip04!.decrypt(PEER, "CIPHER")).toBe("legacy:CIPHER");
    expect(await wrapped.nip44!.decrypt(PEER, "CIPHER")).toBe("plain:CIPHER");
    expect(nip04Decrypt).toHaveBeenCalledTimes(1);
    expect(nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent identical decrypts into one upstream call", async () => {
    const { signer, nip44Decrypt } = makeSigner();
    const wrapped = wrapSignerWithDecryptCache(signer, USER);

    const [a, b] = await Promise.all([
      wrapped.nip44!.decrypt(PEER, "CIPHER"),
      wrapped.nip44!.decrypt(PEER, "CIPHER"),
    ]);
    expect(a).toBe("plain:CIPHER");
    expect(b).toBe("plain:CIPHER");
    expect(nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it("does not cache encrypt or signEvent (always pass through)", async () => {
    const { signer, encrypt, signEvent } = makeSigner();
    const wrapped = wrapSignerWithDecryptCache(signer, USER);

    await wrapped.nip44!.encrypt(PEER, "hello");
    await wrapped.nip44!.encrypt(PEER, "hello");
    expect(encrypt).toHaveBeenCalledTimes(2);

    await wrapped.signEvent({ kind: 1, content: "x", tags: [], created_at: 0 });
    await wrapped.signEvent({ kind: 1, content: "x", tags: [], created_at: 0 });
    expect(signEvent).toHaveBeenCalledTimes(2);
  });

  it("leaves absent crypto methods absent", () => {
    const signer = {
      getPublicKey: vi.fn(),
      signEvent: vi.fn(),
    } as unknown as NostrSigner;
    const wrapped = wrapSignerWithDecryptCache(signer, USER);
    expect(wrapped.nip04).toBeUndefined();
    expect(wrapped.nip44).toBeUndefined();
  });
});

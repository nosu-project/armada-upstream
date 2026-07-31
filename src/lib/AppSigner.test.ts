import { describe, expect, it, vi } from "vitest";

import { AppSigner } from "@/lib/AppSigner";

import type { NostrSigner } from "@nostrify/nostrify";

const PEER = "b".repeat(64);

// Each test uses a unique user pubkey so cache entries never collide across
// tests — the cache id is namespaced by pubkey, so a fresh key is a clean slate
// without having to delete the (connection-held) IndexedDB between tests.
let userCounter = 0;
function freshUser(): string {
  return (userCounter++).toString(16).padStart(64, "0");
}

/** A minimal fake upstream signer with spy-able crypto + sign. */
function makeUpstream(pubkey: string) {
  const nip44Decrypt = vi.fn(async (_p: string, ct: string) => `plain:${ct}`);
  const nip04Decrypt = vi.fn(async (_p: string, ct: string) => `legacy:${ct}`);
  const encrypt = vi.fn(async (_p: string, pt: string) => `ct:${pt}`);
  const signEvent = vi.fn(async (t: unknown) => ({ ...(t as object), id: "x", pubkey, sig: "s" }));
  const getRelays = vi.fn(async () => ({ "wss://r": { read: true, write: true } }));
  const upstream = {
    getPublicKey: vi.fn(async () => pubkey),
    signEvent,
    getRelays,
    nip04: { encrypt, decrypt: nip04Decrypt },
    nip44: { encrypt, decrypt: nip44Decrypt },
  } as unknown as NostrSigner;
  return { upstream, nip44Decrypt, nip04Decrypt, encrypt, signEvent, getRelays };
}

describe("AppSigner", () => {
  it("calls upstream decrypt once, then serves from the persistent cache", async () => {
    const user = freshUser();
    const { upstream, nip44Decrypt } = makeUpstream(user);
    const signer = new AppSigner(upstream, user);

    const a = await signer.nip44!.decrypt(PEER, "CIPHER");
    const b = await signer.nip44!.decrypt(PEER, "CIPHER");

    expect(a).toBe("plain:CIPHER");
    expect(b).toBe("plain:CIPHER");
    expect(nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it("persists across instances (a fresh AppSigner hits the cache)", async () => {
    const user = freshUser();
    const first = makeUpstream(user);
    const firstSigner = new AppSigner(first.upstream, user);
    await firstSigner.nip44!.decrypt(PEER, "CIPHER");
    expect(first.nip44Decrypt).toHaveBeenCalledTimes(1);
    // No per-instance connection to close any more: the cache lives in
    // ArmadaDB's KV, which every signer instance shares.

    // A brand new instance (e.g. after a reload) must read from the same DB.
    const second = makeUpstream(user);
    const val = await new AppSigner(second.upstream, user).nip44!.decrypt(PEER, "CIPHER");
    expect(val).toBe("plain:CIPHER");
    expect(second.nip44Decrypt).not.toHaveBeenCalled();
  });

  it("caches nip04 and nip44 independently (method folded into the id)", async () => {
    const user = freshUser();
    const { upstream, nip04Decrypt, nip44Decrypt } = makeUpstream(user);
    const signer = new AppSigner(upstream, user);

    expect(await signer.nip04!.decrypt(PEER, "CIPHER")).toBe("legacy:CIPHER");
    expect(await signer.nip44!.decrypt(PEER, "CIPHER")).toBe("plain:CIPHER");
    expect(nip04Decrypt).toHaveBeenCalledTimes(1);
    expect(nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it("namespaces by user pubkey (different users do not share entries)", async () => {
    const a = makeUpstream(freshUser());
    const userA = await a.upstream.getPublicKey();
    await new AppSigner(a.upstream, userA).nip44!.decrypt(PEER, "CIPHER");
    expect(a.nip44Decrypt).toHaveBeenCalledTimes(1);

    const b = makeUpstream(freshUser());
    const userB = await b.upstream.getPublicKey();
    await new AppSigner(b.upstream, userB).nip44!.decrypt(PEER, "CIPHER");
    expect(b.nip44Decrypt).toHaveBeenCalledTimes(1); // not a cache hit
  });

  it("dedupes concurrent identical decrypts into one upstream call", async () => {
    const user = freshUser();
    const { upstream, nip44Decrypt } = makeUpstream(user);
    const signer = new AppSigner(upstream, user);

    const [a, b] = await Promise.all([
      signer.nip44!.decrypt(PEER, "CIPHER"),
      signer.nip44!.decrypt(PEER, "CIPHER"),
    ]);
    expect(a).toBe("plain:CIPHER");
    expect(b).toBe("plain:CIPHER");
    expect(nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it("does not cache encrypt or signEvent (always pass through)", async () => {
    const user = freshUser();
    const { upstream, encrypt, signEvent } = makeUpstream(user);
    const signer = new AppSigner(upstream, user);

    await signer.nip44!.encrypt(PEER, "hello");
    await signer.nip44!.encrypt(PEER, "hello");
    expect(encrypt).toHaveBeenCalledTimes(2);

    await signer.signEvent({ kind: 1, content: "x", tags: [], created_at: 0 });
    await signer.signEvent({ kind: 1, content: "x", tags: [], created_at: 0 });
    expect(signEvent).toHaveBeenCalledTimes(2);
  });

  it("forwards getPublicKey and getRelays to upstream", async () => {
    const user = freshUser();
    const { upstream, getRelays } = makeUpstream(user);
    const signer = new AppSigner(upstream, user);
    expect(await signer.getPublicKey()).toBe(user);
    expect(await signer.getRelays()).toEqual({ "wss://r": { read: true, write: true } });
    expect(getRelays).toHaveBeenCalledTimes(1);
  });

  it("leaves absent crypto methods absent", () => {
    const upstream = {
      getPublicKey: vi.fn(),
      signEvent: vi.fn(),
    } as unknown as NostrSigner;
    const signer = new AppSigner(upstream, freshUser());
    expect(signer.nip04).toBeUndefined();
    expect(signer.nip44).toBeUndefined();
  });
});

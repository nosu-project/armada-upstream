import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPlaintextCache,
  decryptCached,
  getCachedPlaintext,
  hasCachedPlaintext,
  setCachedPlaintext,
} from "@/lib/plaintextCache";

// The plaintext memo is module-global; reset between tests.
afterEach(() => clearPlaintextCache());

// decryptCached serializes signer calls per-key via a module-global FIFO queue
// (runExclusive). Use a unique key per test so one test's queue can never block
// another's, mirroring how distinct identities don't share a chain in practice.
let keyCounter = 0;
function freshKey(): string {
  return `signer-${keyCounter++}`.padEnd(64, "0");
}

const PEER = "b".repeat(64);

function ev(id: string, content = "cipher") {
  return { id: id.padEnd(64, "0").slice(0, 64), content };
}

describe("plaintextCache", () => {
  it("set/get/has round-trips", () => {
    expect(hasCachedPlaintext("x")).toBe(false);
    expect(getCachedPlaintext("x")).toBeUndefined();
    setCachedPlaintext("x", "hi");
    expect(hasCachedPlaintext("x")).toBe(true);
    expect(getCachedPlaintext("x")).toBe("hi");
  });

  it("clear empties the memo", () => {
    setCachedPlaintext("x", "hi");
    clearPlaintextCache();
    expect(hasCachedPlaintext("x")).toBe(false);
  });

  it("decryptCached calls the signer once, then serves from memo", async () => {
    const decrypt = vi.fn(async () => "plaintext");
    const e = ev("1");

    const a = await decryptCached(freshKey(), PEER, e, decrypt);
    const b = await decryptCached(freshKey(), PEER, e, decrypt);

    expect(a).toBe("plaintext");
    expect(b).toBe("plaintext");
    expect(decrypt).toHaveBeenCalledTimes(1); // second call was a cache hit
    expect(getCachedPlaintext(e.id)).toBe("plaintext");
  });

  it("dedupes concurrent decrypts of the same id into one signer call", async () => {
    let resolve!: (v: string) => void;
    const decrypt = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const e = ev("2");
    const key = freshKey();

    const p1 = decryptCached(key, PEER, e, decrypt);
    const p2 = decryptCached(key, PEER, e, decrypt);
    // `decrypt` runs inside the signer queue (a microtask later), so wait until
    // it has actually been invoked before resolving it.
    await vi.waitFor(() => expect(decrypt).toHaveBeenCalled());
    resolve("done");

    expect(await p1).toBe("done");
    expect(await p2).toBe("done");
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it("does not memoize a failed decrypt (retryable)", async () => {
    const decrypt = vi
      .fn()
      .mockRejectedValueOnce(new Error("signer refused"))
      .mockResolvedValueOnce("ok");
    const e = ev("3");
    const key = freshKey();

    await expect(decryptCached(key, PEER, e, decrypt)).rejects.toThrow("signer refused");
    expect(hasCachedPlaintext(e.id)).toBe(false);

    // A later attempt succeeds and is now cached.
    expect(await decryptCached(key, PEER, e, decrypt)).toBe("ok");
    expect(getCachedPlaintext(e.id)).toBe("ok");
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it("passes the counterparty and ciphertext to the signer", async () => {
    const decrypt = vi.fn(async () => "p");
    await decryptCached(freshKey(), PEER, ev("4", "CIPHERTEXT"), decrypt);
    expect(decrypt).toHaveBeenCalledWith(PEER, "CIPHERTEXT");
  });
});

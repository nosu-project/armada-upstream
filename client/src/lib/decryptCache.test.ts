import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetDecryptCacheForTests,
  deriveDecryptId,
  getCachedDecrypt,
  putCachedDecrypt,
} from "@/lib/decryptCache";

const USER = "a".repeat(64);
const PEER = "b".repeat(64);

beforeEach(async () => {
  // Wipe the DB between tests so puts don't leak across cases.
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

describe("deriveDecryptId", () => {
  it("is deterministic for identical inputs", async () => {
    const a = await deriveDecryptId("nip44", USER, PEER, "CIPHER");
    const b = await deriveDecryptId("nip44", USER, PEER, "CIPHER");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("differs by method (nip04 vs nip44 are different ciphers)", async () => {
    const a = await deriveDecryptId("nip04", USER, PEER, "CIPHER");
    const b = await deriveDecryptId("nip44", USER, PEER, "CIPHER");
    expect(a).not.toBe(b);
  });

  it("differs by user pubkey (per-account namespacing)", async () => {
    const a = await deriveDecryptId("nip44", USER, PEER, "CIPHER");
    const b = await deriveDecryptId("nip44", "c".repeat(64), PEER, "CIPHER");
    expect(a).not.toBe(b);
  });

  it("differs by counterparty and by ciphertext", async () => {
    const base = await deriveDecryptId("nip44", USER, PEER, "CIPHER");
    expect(await deriveDecryptId("nip44", USER, "d".repeat(64), "CIPHER")).not.toBe(base);
    expect(await deriveDecryptId("nip44", USER, PEER, "OTHER")).not.toBe(base);
  });

  it("is not confused by separator-boundary shifts", async () => {
    // "x" + sep + "y"  must not equal  "x\0y" jammed into one field.
    const a = await deriveDecryptId("nip44", USER, "x", "y");
    const b = await deriveDecryptId("nip44", USER, "x\u0000y", "");
    expect(a).not.toBe(b);
  });
});

describe("decrypt cache store", () => {
  it("round-trips a put then get", async () => {
    const id = await deriveDecryptId("nip44", USER, PEER, "CIPHER");
    expect(await getCachedDecrypt(id)).toBeUndefined();
    await putCachedDecrypt(id, "plaintext");
    expect(await getCachedDecrypt(id)).toBe("plaintext");
  });

  it("returns undefined on a miss", async () => {
    expect(await getCachedDecrypt("deadbeef")).toBeUndefined();
  });
});

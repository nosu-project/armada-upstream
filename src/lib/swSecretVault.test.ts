import { beforeEach, describe, expect, it } from "vitest";

import {
  clearVault,
  openSealedConfig,
  openWithKey,
  sealConfig,
  sealWithKey,
} from "./swSecretVault";

async function freshKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

describe("swSecretVault core (key in hand)", () => {
  it("round-trips a config through AES-GCM", async () => {
    const key = await freshKey();
    const config = { policy: "off", self: "me", knownPeers: ["a", "b"], sk: "deadbeef" };
    const blob = await sealWithKey(key, config);
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(await openWithKey(key, blob)).toEqual(config);
  });

  it("does not decrypt under a different key", async () => {
    const blob = await sealWithKey(await freshKey(), { sk: "secret" });
    expect(await openWithKey(await freshKey(), blob)).toBeNull();
  });

  it("returns null for a tampered blob rather than throwing", async () => {
    const key = await freshKey();
    const blob = await sealWithKey(key, { sk: "secret" });
    blob[blob.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(await openWithKey(key, blob)).toBeNull();
  });
});

describe("swSecretVault (IndexedDB-backed)", () => {
  beforeEach(async () => {
    await clearVault();
  });

  it("seals with a created key and opens it back", async () => {
    const config = { policy: "generic", self: "me", knownPeers: [], sk: "aa" };
    const blob = await sealConfig(config);
    expect(await openSealedConfig(blob)).toEqual(config);
  });

  it("reuses one stored key across seals (persistent, non-extractable)", async () => {
    const a = await sealConfig({ sk: "one" });
    const b = await sealConfig({ sk: "two" });
    // A key created on the first seal must open a blob sealed on the second.
    expect(await openSealedConfig(a)).toEqual({ sk: "one" });
    expect(await openSealedConfig(b)).toEqual({ sk: "two" });
  });

  it("can't open anything once the vault key is cleared", async () => {
    const blob = await sealConfig({ sk: "secret" });
    await clearVault();
    expect(await openSealedConfig(blob)).toBeNull();
  });
});

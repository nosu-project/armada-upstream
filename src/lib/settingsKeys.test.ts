import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";

import { derivedDocOf, generateSettingsRoot, settingsKeyring } from "@/lib/settingsKeys";
import { SETTINGS_DOC_NAMES } from "@/lib/settingsDocs";

const ROOT = "01".repeat(32);

describe("settingsKeys", () => {
  // Frozen: these addresses are wire format. A change here strands every user's settings.
  it("derives the frozen vectors", () => {
    const keyring = settingsKeyring(ROOT);
    const metadata = keyring.settings.metadata;
    expect(bytesToHex(metadata.secretKey)).toBe("4393ed744159666752f834cba4e35faffce6c508f003d38ca2040f7ac1e198e1");
    expect(metadata.pubkey).toBe("e22f5540aaf8e625861e5351a8043ab675310f839298968cd66b14ebf03d2e26");
    expect(metadata.d).toBe("55f5db90268c4a1fdea3675eb48cac7018423b1d3b0d76fe5f92e9db73d65f0a");
    expect(keyring.settings["read-state"].pubkey).toBe("e453486ba22b7d08887937751153f129b5a8d6d0f4bfad23932bf526a531abe4");
    expect(keyring.settings["read-state"].d).toBe("3dfc2ec1870d42fd0e79ca0f0f64ceffdb5ce200e3d9f2c25911ba369ce53a62");
    expect(keyring.gifFavorites.pubkey).toBe("f6c9b55b61c1da51cacffdfd10b68f5ac341c19e3f9d1bec820b6bab8216ef94");
    expect(keyring.gifFavorites.d).toBe("62d221de986706b26a01424a7a47c9d6250f1437a9ab65cddde509e7ca804453");
    expect(keyring.dmConversations[0]!.pubkey).toBe("104f9ae9096f1f362a219988fbe483b1ac47b072d03ddbc84b33482c54b386e3");
    expect(keyring.dmConversations[0]!.d).toBe("0609439fc107b927e6350bb52075dbca3b7b524af1c8d53b70d6a92d0649dadd");
  });

  it("gives every document its own author and d", () => {
    const keyring = settingsKeyring(ROOT);
    expect(keyring.authors).toHaveLength(SETTINGS_DOC_NAMES.length + 1 + 8);
    expect(new Set(keyring.authors).size).toBe(keyring.authors.length);
    expect(new Set([...keyring.byPubkey.values()].map((doc) => doc.d)).size).toBe(keyring.authors.length);
  });

  it("is a pure function of the root", () => {
    const other = settingsKeyring(generateSettingsRoot());
    expect(other.settings.metadata.pubkey).not.toBe(settingsKeyring(ROOT).settings.metadata.pubkey);
    expect(other.id).not.toBe(settingsKeyring(ROOT).id);
  });

  it("matches an event only on author AND d", () => {
    const keyring = settingsKeyring(ROOT);
    const rail = keyring.settings.rail;
    expect(derivedDocOf(keyring, { pubkey: rail.pubkey, tags: [["d", rail.d]] })).toBe(rail);
    expect(derivedDocOf(keyring, { pubkey: rail.pubkey, tags: [["d", keyring.settings.dms.d]] })).toBeUndefined();
    expect(derivedDocOf(keyring, { pubkey: "f".repeat(64), tags: [["d", rail.d]] })).toBeUndefined();
  });

  it("encrypts to the document itself", async () => {
    const { signer, pubkey } = settingsKeyring(ROOT).settings.rail;
    const ciphertext = await signer.nip44!.encrypt(pubkey, "hello");
    expect(await signer.nip44!.decrypt(pubkey, ciphertext)).toBe("hello");
  });
});

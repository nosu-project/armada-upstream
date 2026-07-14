import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

// --- Mock the native plugin -------------------------------------------------
// The plugin talks to a real signer app over Android intents; here we stand in
// a fake that lets us assert the exact argument mapping and echoes back
// plausible results.

const plugin = {
  setPackageName: vi.fn(async (_pkg: string) => undefined),
  getPublicKey: vi.fn(async (_pkg?: string) => ({ pubkey: PUBKEY, package: PKG })),
  getInstalledSignerApps: vi.fn(async () => ({
    apps: [{ name: "Amber", packageName: PKG, iconUrl: "data:," }],
  })),
  signEvent: vi.fn(async (_pkg: string, eventJson: string, _id: string, _pubkey: string) => {
    // Sign for real so `verifyEvent` in the signer passes.
    const unsigned = JSON.parse(eventJson);
    delete unsigned.id;
    delete unsigned.sig;
    const signed = finalizeEvent(unsigned, SK);
    return { event: JSON.stringify(signed), id: signed.id, signature: signed.sig };
  }),
  nip04Encrypt: vi.fn(async (_pkg: string, _text: string, _id: string, _peer: string, _mine: string) => ({ result: "nip04-ct", id: "1" })),
  nip04Decrypt: vi.fn(async (_pkg: string, _text: string, _id: string, _peer: string, _mine: string) => ({ result: "nip04-pt", id: "1" })),
  nip44Encrypt: vi.fn(async (_pkg: string, _text: string, _id: string, _peer: string, _mine: string) => ({ result: "nip44-ct", id: "1" })),
  nip44Decrypt: vi.fn(async (_pkg: string, _text: string, _id: string, _peer: string, _mine: string) => ({ result: "nip44-pt", id: "1" })),
  signPsbt: vi.fn(async (_pkg: string, _hex: string, _id: string, _pubkey: string) => ({ result: "signed-psbt-hex", id: "1" })),
};

vi.mock("capacitor-plugin-nostr-signer", () => ({
  NostrSignerPlugin: plugin,
}));

// A stable identity shared by the mock and the assertions.
const SK = generateSecretKey();
const PUBKEY = getPublicKey(SK);
const PKG = "com.example.signer";
const PEER = "b".repeat(64);

// Import AFTER the mock is registered.
const { AndroidNativeSigner } = await import("@/lib/androidNativeSigner");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AndroidNativeSigner", () => {
  it("binds the package and fetches the pubkey once, then caches it", async () => {
    const signer = new AndroidNativeSigner(PKG);

    expect(await signer.getPublicKey()).toBe(PUBKEY);
    expect(await signer.getPublicKey()).toBe(PUBKEY);

    // Only the first call touches the plugin.
    expect(plugin.setPackageName).toHaveBeenCalledTimes(1);
    expect(plugin.setPackageName).toHaveBeenCalledWith(PKG);
    expect(plugin.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it("does not re-prompt when the pubkey is seeded via the constructor", async () => {
    const signer = new AndroidNativeSigner(PKG, PUBKEY);

    expect(await signer.getPublicKey()).toBe(PUBKEY);
    expect(plugin.getPublicKey).not.toHaveBeenCalled();
  });

  it("signs an event and returns the verified signed event", async () => {
    const signer = new AndroidNativeSigner(PKG, PUBKEY);
    const signed = await signer.signEvent({
      kind: 1,
      content: "hello",
      tags: [],
      created_at: 1700000000,
    });

    expect(signed.pubkey).toBe(PUBKEY);
    expect(signed.sig).toBeTruthy();
    expect(signed.content).toBe("hello");

    // The plugin was handed a precomputed id + placeholder sig + our pubkey.
    const [pkgArg, jsonArg, idArg, pubkeyArg] = plugin.signEvent.mock.calls[0];
    expect(pkgArg).toBe(PKG);
    expect(pubkeyArg).toBe(PUBKEY);
    const sent = JSON.parse(jsonArg as string);
    expect(sent.id).toBe(idArg);
    expect(sent.sig).toBe("");
    expect(sent.pubkey).toBe(PUBKEY);
  });

  it("throws when the signer returns an invalid signature", async () => {
    plugin.signEvent.mockResolvedValueOnce({
      event: JSON.stringify({
        id: "0".repeat(64),
        pubkey: PUBKEY,
        kind: 1,
        content: "tampered",
        tags: [],
        created_at: 1700000000,
        sig: "0".repeat(128),
      }),
      id: "0".repeat(64),
      signature: "0".repeat(128),
    });

    const signer = new AndroidNativeSigner(PKG, PUBKEY);
    await expect(
      signer.signEvent({ kind: 1, content: "x", tags: [], created_at: 1 }),
    ).rejects.toThrow(/invalid signature/i);
  });

  it("maps nip04/nip44 encrypt & decrypt to the plugin with (counterparty, myPubkey)", async () => {
    const signer = new AndroidNativeSigner(PKG, PUBKEY);

    expect(await signer.nip04.encrypt(PEER, "msg")).toBe("nip04-ct");
    expect(await signer.nip04.decrypt(PEER, "ct")).toBe("nip04-pt");
    expect(await signer.nip44.encrypt(PEER, "msg")).toBe("nip44-ct");
    expect(await signer.nip44.decrypt(PEER, "ct")).toBe("nip44-pt");

    // nipXX(pkg, text, id, counterpartyPubkey, myPubkey)
    const enc = plugin.nip44Encrypt.mock.calls[0];
    expect(enc[0]).toBe(PKG);
    expect(enc[1]).toBe("msg");
    expect(enc[3]).toBe(PEER);
    expect(enc[4]).toBe(PUBKEY);
  });

  it("forwards PSBT signing to the plugin", async () => {
    const signer = new AndroidNativeSigner(PKG, PUBKEY);
    expect(await signer.signPsbt("aabbcc")).toBe("signed-psbt-hex");

    const [pkgArg, hexArg, , pubkeyArg] = plugin.signPsbt.mock.calls[0];
    expect(pkgArg).toBe(PKG);
    expect(hexArg).toBe("aabbcc");
    expect(pubkeyArg).toBe(PUBKEY);
  });

  it("lists installed signer apps", async () => {
    const apps = await AndroidNativeSigner.getSignerApps();
    expect(apps).toHaveLength(1);
    expect(apps[0].packageName).toBe(PKG);
  });
});

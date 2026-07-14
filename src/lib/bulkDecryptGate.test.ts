import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mayBulkDecrypt, signerNeedsApproval } from "@/lib/bulkDecryptGate";
import {
  registerConsentPromptOpener,
  setDecryptConsent,
  __resetDecryptConsentForTests,
} from "@/lib/decryptConsent";

import type { NostrSigner } from "@nostrify/nostrify";

/** A signer with an AppSigner-style `isDecryptCached` peek. */
function fakeSigner(cachedCiphertexts: Set<string>): NostrSigner {
  return {
    isDecryptCached: vi.fn(async (_m: string, _cp: string, ct: string) => cachedCiphertexts.has(ct)),
  } as unknown as NostrSigner;
}

beforeEach(() => __resetDecryptConsentForTests());
afterEach(() => __resetDecryptConsentForTests());

const targets = [
  { counterparty: "a".repeat(64), ciphertext: "ct1" },
  { counterparty: "a".repeat(64), ciphertext: "ct2" },
];

describe("signerNeedsApproval", () => {
  it("is false for a local nsec (no approval to gate)", () => {
    expect(signerNeedsApproval("nsec")).toBe(false);
  });

  it("is true for remote/extension signers and unknown methods", () => {
    expect(signerNeedsApproval("bunker")).toBe(true);
    expect(signerNeedsApproval("extension")).toBe(true);
    expect(signerNeedsApproval(undefined)).toBe(true);
  });
});

describe("mayBulkDecrypt", () => {
  it("proceeds with an empty batch (nothing to gate)", async () => {
    await expect(mayBulkDecrypt(fakeSigner(new Set()), "nip04", [], true)).resolves.toBe(true);
  });

  it("proceeds without prompting when the signer needs no approval (nsec)", async () => {
    const opener = vi.fn();
    registerConsentPromptOpener(opener);
    // Uncached, undecided — but a local signer can't prompt, so just decrypt.
    await expect(mayBulkDecrypt(fakeSigner(new Set()), "nip04", targets, false)).resolves.toBe(true);
    expect(opener).not.toHaveBeenCalled();
  });

  it("proceeds without prompting when consent is already allowed", async () => {
    setDecryptConsent("allowed");
    const opener = vi.fn();
    registerConsentPromptOpener(opener);
    await expect(mayBulkDecrypt(fakeSigner(new Set()), "nip44", targets, true)).resolves.toBe(true);
    expect(opener).not.toHaveBeenCalled();
  });

  it("proceeds silently when EVERY target is already cached, even if declined", async () => {
    setDecryptConsent("declined");
    const signer = fakeSigner(new Set(["ct1", "ct2"]));
    await expect(mayBulkDecrypt(signer, "nip04", targets, true)).resolves.toBe(true);
  });

  it("refuses when declined and some target is uncached", async () => {
    setDecryptConsent("declined");
    const signer = fakeSigner(new Set(["ct1"])); // ct2 uncached
    await expect(mayBulkDecrypt(signer, "nip04", targets, true)).resolves.toBe(false);
  });

  it("skips the prompt entirely when undecided but everything is cached", async () => {
    const opener = vi.fn();
    registerConsentPromptOpener(opener);
    const signer = fakeSigner(new Set(["ct1", "ct2"]));
    await expect(mayBulkDecrypt(signer, "nip04", targets, true)).resolves.toBe(true);
    expect(opener).not.toHaveBeenCalled();
  });

  it("prompts once when undecided with uncached targets, honoring the answer", async () => {
    const opener = vi.fn();
    registerConsentPromptOpener(opener);
    const signer = fakeSigner(new Set());
    const decision = mayBulkDecrypt(signer, "nip04", targets, true);
    // The gate awaits an async cache peek before prompting; let it settle.
    await vi.waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    setDecryptConsent("allowed");
    await expect(decision).resolves.toBe(true);
  });
});

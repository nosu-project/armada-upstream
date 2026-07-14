import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureDecryptConsent,
  getDecryptConsent,
  isConsentPromptPending,
  registerConsentPromptOpener,
  resolveConsentPrompt,
  setDecryptConsent,
  __resetDecryptConsentForTests,
} from "@/lib/decryptConsent";

beforeEach(() => {
  __resetDecryptConsentForTests();
});

afterEach(() => {
  __resetDecryptConsentForTests();
});

describe("decryptConsent", () => {
  it("starts undecided and persists a decision", () => {
    expect(getDecryptConsent()).toBeNull();
    setDecryptConsent("allowed");
    expect(getDecryptConsent()).toBe("allowed");
    expect(localStorage.getItem("armada:decrypt-consent")).toBe("allowed");
  });

  it("resolves immediately when already decided (no prompt)", async () => {
    setDecryptConsent("declined");
    const opener = vi.fn();
    registerConsentPromptOpener(opener);
    await expect(ensureDecryptConsent()).resolves.toBe("declined");
    expect(opener).not.toHaveBeenCalled();
  });

  it("opens exactly ONE prompt for concurrent callers and shares the answer", async () => {
    const opener = vi.fn();
    registerConsentPromptOpener(opener);

    const a = ensureDecryptConsent();
    const b = ensureDecryptConsent();
    const c = ensureDecryptConsent();

    expect(opener).toHaveBeenCalledTimes(1);
    expect(isConsentPromptPending()).toBe(true);

    setDecryptConsent("allowed"); // the user answers the single dialog

    await expect(Promise.all([a, b, c])).resolves.toEqual(["allowed", "allowed", "allowed"]);
    expect(isConsentPromptPending()).toBe(false);
  });

  it("declines conservatively when no dialog opener is registered", async () => {
    await expect(ensureDecryptConsent()).resolves.toBe("declined");
    // A bare fallback decline is NOT persisted — the user is asked again later.
    expect(getDecryptConsent()).toBeNull();
  });

  it("a bare resolveConsentPrompt(declined) does not persist", async () => {
    const opener = vi.fn();
    registerConsentPromptOpener(opener);
    const p = ensureDecryptConsent();
    resolveConsentPrompt("declined"); // e.g. Esc / backdrop dismiss
    await expect(p).resolves.toBe("declined");
    expect(getDecryptConsent()).toBeNull();
  });

  it("unregistering the opener stops it receiving prompts", async () => {
    const opener = vi.fn();
    const unregister = registerConsentPromptOpener(opener);
    unregister();
    // No opener now → conservative decline.
    await expect(ensureDecryptConsent()).resolves.toBe("declined");
    expect(opener).not.toHaveBeenCalled();
  });
});

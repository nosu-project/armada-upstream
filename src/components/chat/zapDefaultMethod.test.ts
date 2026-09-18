import { describe, expect, it } from "vitest";

import { pickDefaultZapMethod } from "@/components/chat/zapDefaultMethod";

/** A recipient with Lightning + Bitcoin (the common case). */
const bothMethods = ["bitcoin", "lightning"] as const;

describe("pickDefaultZapMethod", () => {
  it("honours a usable preferred method", () => {
    expect(
      pickDefaultZapMethod({
        preferred: "bitcoin",
        available: bothMethods,
        lightningAvailable: true,
        walletRequired: false,
        bitcoinUnsupported: false,
      }),
    ).toBe("bitcoin");

    expect(
      pickDefaultZapMethod({
        preferred: "lightning",
        available: bothMethods,
        lightningAvailable: true,
        walletRequired: false,
        bitcoinUnsupported: false,
      }),
    ).toBe("lightning");
  });

  // The reported bug: a private zap with no connected wallet blocks the
  // Lightning pane, so opening on it looks like "no payment options available".
  it("falls back to Bitcoin when the Lightning preference is wallet-blocked", () => {
    expect(
      pickDefaultZapMethod({
        preferred: "lightning",
        available: bothMethods,
        lightningAvailable: true,
        walletRequired: true,
        bitcoinUnsupported: false,
      }),
    ).toBe("bitcoin");
  });

  it("stays on Bitcoin's QR fallback rather than a wallet-blocked Lightning pane", () => {
    // Signer can't sign PSBTs (Bitcoin uses the scan-to-pay QR) AND there's no
    // wallet for a private zap — Bitcoin's QR still works, blocked Lightning
    // doesn't, so don't jump to Lightning.
    expect(
      pickDefaultZapMethod({
        preferred: "bitcoin",
        available: bothMethods,
        lightningAvailable: true,
        walletRequired: true,
        bitcoinUnsupported: true,
      }),
    ).toBe("bitcoin");
  });

  it("prefers usable Lightning when Bitcoin's signer can't sign PSBTs", () => {
    expect(
      pickDefaultZapMethod({
        preferred: "bitcoin",
        available: bothMethods,
        lightningAvailable: true,
        walletRequired: false,
        bitcoinUnsupported: true,
      }),
    ).toBe("lightning");
  });

  it("falls back to Bitcoin when the recipient has no Lightning at all", () => {
    expect(
      pickDefaultZapMethod({
        preferred: "lightning",
        available: ["bitcoin"],
        lightningAvailable: false,
        walletRequired: false,
        bitcoinUnsupported: false,
      }),
    ).toBe("bitcoin");
  });

  it("never returns a method absent from the list", () => {
    // Lightning preferred and usable in principle, but not offered.
    expect(
      pickDefaultZapMethod({
        preferred: "lightning",
        available: ["bitcoin", "monero"],
        lightningAvailable: false,
        walletRequired: false,
        bitcoinUnsupported: false,
      }),
    ).toBe("bitcoin");
  });
});

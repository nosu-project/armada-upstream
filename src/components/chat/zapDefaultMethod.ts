export interface PickDefaultZapMethodOpts {
  /**
   * The user's configured `defaultZapMethod` — any recognized method type
   * ("bitcoin", "lightning", "monero", …).
   */
  preferred: string;
  /** Method ids present in the dialog, in order. Always includes "bitcoin". */
  available: readonly string[];
  /** Recipient can receive Lightning (profile lud06/16, or a NIP-A3 target). */
  lightningAvailable: boolean;
  /**
   * Lightning can't be completed here: a private (Concord) zap with no
   * connected wallet, whose tally needs a preimage only NWC/WebLN can return.
   */
  walletRequired: boolean;
  /** The signer can't sign PSBTs, so Bitcoin falls back to a scan-to-pay QR. */
  bitcoinUnsupported: boolean;
}

/**
 * Choose which pane the zap dialog opens on.
 *
 * The rule that matters: never land on a method the user can't actually
 * complete, or the dialog looks like it offers no payment options at all. A
 * private zap's Lightning pane is a dead end without a connected wallet
 * (`walletRequired`); Bitcoin ALWAYS works (native, or the unsupported-signer
 * QR fallback); and every generic method (Monero, Ethereum, …) needs no wallet,
 * so it's honoured whenever the recipient offers it. Honour the preference only
 * when it's usable here; otherwise fall through to a reliable working pane.
 */
export function pickDefaultZapMethod(opts: PickDefaultZapMethodOpts): string {
  const { preferred, available, lightningAvailable, walletRequired, bitcoinUnsupported } = opts;
  const has = (id: string) => available.includes(id);

  const lightningUsable = has("lightning") && lightningAvailable && !walletRequired;

  // Whether the user's preferred method can be completed from here.
  //  - Lightning needs a wallet for a private zap (walletRequired).
  //  - Bitcoin is skipped as a *preference* when the signer can't sign PSBTs,
  //    so a nicer default is chosen below — the QR fallback still backs it up.
  //  - A generic method (Monero, Ethereum, …) is honoured whenever the
  //    recipient offers it: it needs no wallet and no signer.
  const preferenceUsable =
    preferred === "lightning"
      ? lightningUsable
      : preferred === "bitcoin"
        ? has("bitcoin") && !bitcoinUnsupported
        : has(preferred);
  if (preferenceUsable) return preferred;

  // Preference unusable or the recipient doesn't offer it — fall back to a
  // working pane. Prefer Lightning when it's genuinely usable; otherwise
  // Bitcoin (whose QR fallback works even when PSBT signing doesn't).
  if (lightningUsable) return "lightning";
  return has("bitcoin") ? "bitcoin" : (available[0] ?? "bitcoin");
}

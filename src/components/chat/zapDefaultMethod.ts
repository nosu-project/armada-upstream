export interface PickDefaultZapMethodOpts {
  /** The user's configured `defaultZapMethod` ("bitcoin", "lightning", "monero", …). */
  preferred: string;
  /** Method ids present in the dialog, in order. Always includes "bitcoin". */
  available: readonly string[];
  /** Recipient can receive Lightning (profile lud06/16, or a NIP-A3 target). */
  lightningAvailable: boolean;
  /** Private (Concord) zap with no wallet: the tally needs a preimage only NWC/WebLN can return. */
  walletRequired: boolean;
  /** The signer can't sign PSBTs, so Bitcoin falls back to a scan-to-pay QR. */
  bitcoinUnsupported: boolean;
}

/**
 * Choose which pane the zap dialog opens on. Never land on a method the user
 * can't complete: private Lightning needs a wallet; Bitcoin always works (QR
 * fallback); generic methods need no wallet.
 */
export function pickDefaultZapMethod(opts: PickDefaultZapMethodOpts): string {
  const { preferred, available, lightningAvailable, walletRequired, bitcoinUnsupported } = opts;
  const has = (id: string) => available.includes(id);

  const lightningUsable = has("lightning") && lightningAvailable && !walletRequired;

  // Bitcoin is skipped as a preference when the signer can't sign PSBTs so a
  // nicer default is chosen; the QR fallback still backs it up.
  const preferenceUsable =
    preferred === "lightning"
      ? lightningUsable
      : preferred === "bitcoin"
        ? has("bitcoin") && !bitcoinUnsupported
        : has(preferred);
  if (preferenceUsable) return preferred;

  if (lightningUsable) return "lightning";
  return has("bitcoin") ? "bitcoin" : (available[0] ?? "bitcoin");
}

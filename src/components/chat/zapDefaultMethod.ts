export type ZapMethodPref = "lightning" | "bitcoin";

export interface PickDefaultZapMethodOpts {
  /** The user's configured `defaultZapMethod`. */
  preferred: ZapMethodPref;
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
 * (`walletRequired`), while Bitcoin ALWAYS works — natively, or through the
 * unsupported-signer QR fallback — so it is the reliable landing pane whenever
 * the preferred method is blocked. Honour the preference only when it's usable;
 * otherwise fall through to whatever works.
 */
export function pickDefaultZapMethod(opts: PickDefaultZapMethodOpts): string {
  const { preferred, available, lightningAvailable, walletRequired, bitcoinUnsupported } = opts;
  const has = (id: string) => available.includes(id);

  // Lightning is only a landing pane when the recipient takes it AND the user
  // can pay it from here.
  const lightningUsable = has("lightning") && lightningAvailable && !walletRequired;
  // Bitcoin is preferable when its native flow is available; when the signer
  // can't sign PSBTs the pane still works (QR fallback), but a usable Lightning
  // is the nicer default in that case.
  const bitcoinPreferable = has("bitcoin") && !bitcoinUnsupported;

  if (preferred === "lightning" && lightningUsable) return "lightning";
  if (preferred === "bitcoin" && bitcoinPreferable) return "bitcoin";

  // Preference unusable — fall back to a working pane. Prefer Lightning only
  // when it's genuinely usable; otherwise Bitcoin (whose QR fallback works even
  // when PSBT signing doesn't).
  if (lightningUsable) return "lightning";
  return has("bitcoin") ? "bitcoin" : (available[0] ?? "bitcoin");
}

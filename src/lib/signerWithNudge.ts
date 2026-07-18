import type { NostrEvent, NostrSigner } from "@nostrify/types";
import { createElement } from "react";

import { NudgeToastContent } from "@/components/SignerToastContent";
import { toast } from "@/hooks/useToast";
import { type BtcSigner, hasBtcSigning } from "@/lib/bitcoin-signers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Show the nudge toast after this delay if a signer op is still pending. */
const NUDGE_DELAY_MS = 4_000;

/**
 * Hard timeout — reject the op entirely after this long with no response.
 *
 * Set just above the Nip46Signer worst case (2 attempts × 30s) so the fence
 * can never amputate a live retry — the signer's own, more precise error
 * surfaces instead. For NIP-07 extension signers, which have NO underlying
 * timeout (an extension ignored by the user pends forever), this is the only
 * fence.
 */
const HARD_TIMEOUT_MS = 65_000;

/** Minimum gap between nudge toasts (ms). Prevents rapid-fire replacements. */
const NUDGE_THROTTLE_MS = 8_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

type OpType = "sign" | "encrypt" | "decrypt";

/** Context-specific subjects for nudge toast titles (Armada's kinds). */
const NUDGE_OVERRIDES: Record<number, string> = {
  0: "profile update",
  1: "post",
  3: "contact list update",
  7: "reaction",
  9: "message",
  1059: "direct message",
  9734: "zap request",
  9735: "zap",
  10009: "server list update",
  24242: "file upload auth",
  30078: "app settings",
};

function labelForOp(kind: number | undefined, opType: OpType): string {
  if (kind !== undefined && NUDGE_OVERRIDES[kind]) return NUDGE_OVERRIDES[kind];
  if (opType === "encrypt") return "encryption";
  if (opType === "decrypt") return "decryption";
  return "signing";
}

// ---------------------------------------------------------------------------
// Sentinel values used to signal control flow inside Promise.race
// ---------------------------------------------------------------------------

const CANCEL = Symbol("cancel");
const TIMEOUT = Symbol("timeout");

type Signal = typeof CANCEL | typeof TIMEOUT;

// ---------------------------------------------------------------------------
// Toast deduplication — prevent a storm of identical nudge toasts
// ---------------------------------------------------------------------------

/** Timestamp of the last nudge toast shown. Used to throttle. */
let lastNudgeShownAt = 0;

// ---------------------------------------------------------------------------
// Toast helpers
// ---------------------------------------------------------------------------

/**
 * Shows the nudge toast with interactive buttons. Returns a dismiss handle.
 *
 * On Android the toast includes an "Approve in signer" link that opens the
 * signer via the `nostrsigner:` URI scheme (keeps the WebSocket alive), plus
 * a Skip/Cancel button. On desktop it shows a description with a Skip button.
 */
function showNudgeToast(opts: {
  kind: number | undefined;
  opType: OpType;
  isBunkerConnected: (() => boolean) | undefined;
  onCancel: () => void;
}): { dismiss: () => void } {
  const { kind, opType, isBunkerConnected, onCancel } = opts;
  const android = isAndroid();
  const relayOk = isBunkerConnected ? isBunkerConnected() : true;
  const subject = labelForOp(kind, opType);

  // Throttle: if a nudge was shown recently, return a no-op dismiss handle
  // to avoid a storm of rapidly replacing toasts on unstable connections.
  const now = Date.now();
  if (now - lastNudgeShownAt < NUDGE_THROTTLE_MS) {
    return { dismiss: () => {} };
  }
  lastNudgeShownAt = now;

  let title: string;
  let descriptionText: string;

  if (!relayOk) {
    title = "Signer relay unreachable";
    descriptionText = "Check your connection and try again.";
  } else if (android) {
    title = `Approve ${subject}`;
    descriptionText = "Set to auto-approve for a smoother experience.";
  } else {
    title = `Approve ${subject}`;
    descriptionText = "Approve the request in your signer app.";
  }

  // Capture the dismiss function so the onCancel callback inside the
  // component can dismiss the toast (mutable-ref pattern: the closure
  // captures the container, not the value).
  const dismissRef: { fn: (() => void) | undefined } = { fn: undefined };

  const description = createElement(NudgeToastContent, {
    description: descriptionText,
    android,
    relayOk,
    onCancel: () => { dismissRef.fn?.(); onCancel(); },
  });

  // A long but finite duration so Radix swipe-to-dismiss works on mobile.
  // The toast is dismissed programmatically on operation completion anyway.
  const { dismiss } = toast({ title, description, duration: 120_000 });
  dismissRef.fn = dismiss;

  return { dismiss };
}

function showSuccessToast(opType: OpType): void {
  const verb = opType === "encrypt" ? "Encryption" : opType === "decrypt" ? "Decryption" : "Signing";
  toast({ title: `${verb} approved`, duration: 3000, variant: "success" });
}

// ---------------------------------------------------------------------------
// Core: run a signer operation with nudge + cancel + hard timeout
// ---------------------------------------------------------------------------

interface RunOpts {
  kind: number | undefined;
  opType: OpType;
  isBunkerConnected: (() => boolean) | undefined;
}

/** Creates a deferred promise. Used to race against the actual signer op. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Runs `op` with:
 * - a nudge toast after NUDGE_DELAY_MS if still pending,
 * - a Skip/Cancel button on that toast,
 * - a hard timeout at HARD_TIMEOUT_MS.
 */
async function runWithNudge<T>(op: () => Promise<T>, opts: RunOpts): Promise<T> {
  const { kind, opType, isBunkerConnected } = opts;

  // Tagged outcome type used to distinguish op results from control signals.
  type Outcome =
    | { tag: "value"; value: T }
    | { tag: "error"; error: unknown }
    | { tag: "signal"; signal: Signal };

  let nudgeFired = false;

  // Signal channels — each resolves with a sentinel when its condition fires.
  const cancelSignal = deferred<typeof CANCEL>();
  const timeoutSignal = deferred<typeof TIMEOUT>();

  // --- Nudge timer ---
  let dismissNudge: (() => void) | undefined;
  const nudgeTimer = setTimeout(() => {
    nudgeFired = true;
    const handle = showNudgeToast({
      kind, opType, isBunkerConnected,
      onCancel: () => cancelSignal.resolve(CANCEL),
    });
    dismissNudge = handle.dismiss;
  }, NUDGE_DELAY_MS);

  // --- Hard timeout ---
  const hardTimer = setTimeout(() => timeoutSignal.resolve(TIMEOUT), HARD_TIMEOUT_MS);

  function cleanup() {
    clearTimeout(nudgeTimer);
    clearTimeout(hardTimer);
    dismissNudge?.();
  }

  const opOutcome: Promise<Outcome> = op().then(
    (value): Outcome => ({ tag: "value", value }),
    (error): Outcome => ({ tag: "error", error }),
  );

  const signalOutcome: Promise<Outcome> = Promise.race([
    cancelSignal.promise,
    timeoutSignal.promise,
  ]).then((signal): Outcome => ({ tag: "signal", signal }));

  const outcome = await Promise.race([opOutcome, signalOutcome]);
  cleanup();

  if (outcome.tag === "value") {
    if (nudgeFired) showSuccessToast(opType);
    return outcome.value;
  }

  if (outcome.tag === "error") {
    throw outcome.error;
  }

  // outcome.tag === "signal"
  switch (outcome.signal) {
    case CANCEL:
      throw new Error("Signing cancelled by user");
    case TIMEOUT:
      throw new Error("Signer timed out");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The AppSigner decrypt-cache peek, forwarded so bulkDecryptGate keeps working. */
interface DecryptCachePeek {
  isDecryptCached(method: "nip04" | "nip44", counterparty: string, ciphertext: string): Promise<boolean>;
}

/**
 * Wraps the user-facing signer with the UX a slow remote/external signer
 * needs (ported from ditto):
 *
 * - a nudge toast after 4s if a sign op is still pending, so the user knows
 *   to check their signer app — with an Android "Approve in signer" deep
 *   link, a relay-unreachable variant, and a Skip/Cancel escape hatch;
 * - a hard timeout (see HARD_TIMEOUT_MS) so no op can pend forever;
 * - a confirmation toast when an op the user was nudged about completes.
 *
 * nip04/nip44 encrypt+decrypt pass through un-nudged: bulk decrypts are
 * already consent-gated (bulkDecryptGate), and per-ciphertext toasts would
 * spam. `signPsbt` and AppSigner's `isDecryptCached` are forwarded.
 *
 * @param signer - The underlying NostrSigner to wrap.
 * @param isBunkerConnected - Optional callback checked at nudge time; when it
 *   returns false the toast warns about a relay connectivity problem instead.
 */
export function signerWithNudge(
  signer: NostrSigner,
  isBunkerConnected?: () => boolean,
): NostrSigner {
  function run<T>(op: () => Promise<T>, kind: number | undefined, opType: OpType): Promise<T> {
    return runWithNudge(op, { kind, opType, isBunkerConnected });
  }

  const wrapped: NostrSigner = {
    getPublicKey: () => run(() => signer.getPublicKey(), undefined, "sign"),
    signEvent: (event: NostrEvent) => run(() => signer.signEvent(event), event.kind, "sign"),
  };

  if (signer.getRelays) {
    const getRelays = signer.getRelays.bind(signer);
    wrapped.getRelays = () => run(() => getRelays(), undefined, "sign");
  }

  // Crypto passes through: decrypts are served from the persistent cache
  // where possible (AppSigner) and consent-gated in bulk (bulkDecryptGate) —
  // a nudge per ciphertext would toast-spam the user during inbox sweeps.
  if (signer.nip04) wrapped.nip04 = signer.nip04;
  if (signer.nip44) wrapped.nip44 = signer.nip44;

  // Forward signPsbt if the underlying signer supports Bitcoin signing.
  if (hasBtcSigning(signer)) {
    const btcSigner = signer;
    (wrapped as BtcSigner).signPsbt = (psbtHex: string) =>
      run(() => btcSigner.signPsbt(psbtHex), undefined, "sign");
  }

  // Forward AppSigner's cache peek so the bulk-decrypt consent gate can still
  // tell "would hit the signer" apart from "served from cache".
  const peekable = signer as Partial<DecryptCachePeek>;
  if (typeof peekable.isDecryptCached === "function") {
    (wrapped as NostrSigner & DecryptCachePeek).isDecryptCached =
      peekable.isDecryptCached.bind(signer);
  }

  return wrapped;
}

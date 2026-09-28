import type { NostrEvent, NostrSigner } from "@nostrify/types";
import { createElement } from "react";

import { NudgeToastContent } from "@/components/SignerToastContent";
import { toast } from "@/hooks/useToast";
import { type BtcSigner, hasBtcSigning } from "@/lib/bitcoin-signers";

/** Show the nudge toast after this delay if a signer op is still pending. */
const NUDGE_DELAY_MS = 4_000;

/**
 * Reject the op after this long. Just above Nip46Signer's worst case (2 × 30s)
 * so it never cuts a live retry; the only fence for NIP-07 extensions.
 */
const HARD_TIMEOUT_MS = 65_000;

/** Minimum gap between nudge toasts. */
const NUDGE_THROTTLE_MS = 8_000;

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

/** Sentinels for control flow inside Promise.race. */
const CANCEL = Symbol("cancel");
const TIMEOUT = Symbol("timeout");

type Signal = typeof CANCEL | typeof TIMEOUT;

let lastNudgeShownAt = 0;

/** Show the nudge toast (Android adds a `nostrsigner:` "Approve in signer" link). */
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

  // Mutable ref so the component's onCancel can dismiss its own toast.
  const dismissRef: { fn: (() => void) | undefined } = { fn: undefined };

  const description = createElement(NudgeToastContent, {
    description: descriptionText,
    android,
    relayOk,
    onCancel: () => { dismissRef.fn?.(); onCancel(); },
  });

  // Finite so Radix swipe-to-dismiss works on mobile.
  const { dismiss } = toast({ title, description, duration: 120_000 });
  dismissRef.fn = dismiss;

  return { dismiss };
}

function showSuccessToast(opType: OpType): void {
  const verb = opType === "encrypt" ? "Encryption" : opType === "decrypt" ? "Decryption" : "Signing";
  toast({ title: `${verb} approved`, duration: 3000, variant: "success" });
}

interface RunOpts {
  kind: number | undefined;
  opType: OpType;
  isBunkerConnected: (() => boolean) | undefined;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Run `op` with a nudge toast after NUDGE_DELAY_MS, a cancel button, and a hard timeout. */
async function runWithNudge<T>(op: () => Promise<T>, opts: RunOpts): Promise<T> {
  const { kind, opType, isBunkerConnected } = opts;

  type Outcome =
    | { tag: "value"; value: T }
    | { tag: "error"; error: unknown }
    | { tag: "signal"; signal: Signal };

  let nudgeFired = false;

  const cancelSignal = deferred<typeof CANCEL>();
  const timeoutSignal = deferred<typeof TIMEOUT>();

  let dismissNudge: (() => void) | undefined;
  const nudgeTimer = setTimeout(() => {
    nudgeFired = true;
    const handle = showNudgeToast({
      kind, opType, isBunkerConnected,
      onCancel: () => cancelSignal.resolve(CANCEL),
    });
    dismissNudge = handle.dismiss;
  }, NUDGE_DELAY_MS);

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

  switch (outcome.signal) {
    case CANCEL:
      throw new Error("Signing cancelled by user");
    case TIMEOUT:
      throw new Error("Signer timed out");
  }
}

/** The AppSigner decrypt-cache peek, forwarded so bulkDecryptGate keeps working. */
interface DecryptCachePeek {
  isDecryptCached(method: "nip04" | "nip44", counterparty: string, ciphertext: string): Promise<boolean>;
}

/**
 * Wrap a signer with slow-remote-signer UX (ported from ditto): a nudge toast
 * after 4s, a hard timeout, and a confirmation toast after a nudged op. nip04/
 * nip44 pass through un-nudged (bulk decrypts are consent-gated by
 * bulkDecryptGate). `signPsbt` and AppSigner's `isDecryptCached` are forwarded.
 *
 * @param isBunkerConnected - Checked at nudge time; false shows a relay-unreachable warning.
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

  // Crypto passes through: per-ciphertext nudges would spam during inbox sweeps.
  if (signer.nip04) wrapped.nip04 = signer.nip04;
  if (signer.nip44) wrapped.nip44 = signer.nip44;

  if (hasBtcSigning(signer)) {
    const btcSigner = signer;
    (wrapped as BtcSigner).signPsbt = (psbtHex: string) =>
      run(() => btcSigner.signPsbt(psbtHex), undefined, "sign");
  }

  // bulkDecryptGate needs the cache peek to tell cache hits from signer calls.
  const peekable = signer as Partial<DecryptCachePeek>;
  if (typeof peekable.isDecryptCached === "function") {
    (wrapped as NostrSigner & DecryptCachePeek).isDecryptCached =
      peekable.isDecryptCached.bind(signer);
  }

  return wrapped;
}

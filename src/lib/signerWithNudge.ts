import type { NostrEvent, NostrSigner } from "@nostrify/types";
import { createElement } from "react";

import { NudgeToastContent } from "@/components/SignerToastContent";
import { toast } from "@/hooks/useToast";
import { type BtcSigner, hasBtcSigning } from "@/lib/bitcoin-signers";

/** Show the nudge once the signer has answered nothing for this long with work pending. */
const NUDGE_DELAY_MS = 4_000;

/**
 * Reject the op after this long: the only fence for NIP-07 extensions. A
 * remote signer passes its own (`hardTimeoutMs`) above Nip46Signer's budget,
 * so a user still on their way to approve isn't cut off.
 */
const HARD_TIMEOUT_MS = 65_000;

/** Minimum gap between nudge toasts. */
const NUDGE_THROTTLE_MS = 8_000;

type OpType = "sign" | "encrypt" | "decrypt";

/** Context-specific subjects for nudge toast titles (Armada's kinds). */
const NUDGE_OVERRIDES: Record<number, string> = {
  0: "profile update",
  1: "post",
  3: "contact list update",
  7: "reaction",
  9: "message",
  13: "direct message",
  1059: "direct message",
  9734: "zap request",
  9735: "zap",
  10009: "server list update",
  // Concord: messages, reactions and Joins are all 20013 seals; the template
  // can't tell which (the rumor is encrypted), so name what they share.
  20013: "community activity",
  20014: "community update",
  33302: "community membership",
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

/**
 * Show the nudge toast. No `nostrsigner:` link: it can't open a NIP-46 queue,
 * and Amber ≥ 6.1 rejects it as malformed whenever its queue is empty.
 */
function showNudgeToast(opts: {
  kind: number | undefined;
  opType: OpType;
  isBunkerConnected: (() => boolean) | undefined;
  remote: boolean;
  durationMs: number;
  onCancel: () => void;
}): { dismiss: () => void } {
  const { kind, opType, isBunkerConnected, remote, durationMs, onCancel } = opts;
  const relayOk = isBunkerConnected ? isBunkerConnected() : true;
  const subject = labelForOp(kind, opType);

  let title: string;
  let descriptionText: string;

  if (!relayOk) {
    title = "Signer relay unreachable";
    descriptionText = "Check your connection and try again.";
  } else if (remote) {
    title = `Approve ${subject}`;
    // Amber's default policy asks once per kind; "Always" ends the prompts.
    descriptionText = 'Open your signer app (Amber…) and approve the request. Choose "Always" so it isn\'t asked again.';
  } else {
    title = `Approve ${subject}`;
    descriptionText = "Approve the request in your signer.";
  }

  // Mutable ref so the component's onCancel can dismiss its own toast.
  const dismissRef: { fn: (() => void) | undefined } = { fn: undefined };

  const description = createElement(NudgeToastContent, {
    description: descriptionText,
    onCancel: () => { dismissRef.fn?.(); onCancel(); },
  });

  // Finite so Radix swipe-to-dismiss works on mobile; as long as the op may wait.
  const { dismiss } = toast({ title, description, duration: durationMs });
  dismissRef.fn = dismiss;

  return { dismiss };
}

function showSuccessToast(opType: OpType): void {
  const verb = opType === "encrypt" ? "Encryption" : opType === "decrypt" ? "Decryption" : "Signing";
  toast({ title: `${verb} approved`, duration: 3000, variant: "success" });
}

interface PendingOp {
  kind: number | undefined;
  opType: OpType;
  cancel: () => void;
}

/**
 * One nudge per STALL of a signer, shared by all its ops. Remote signers serve
 * requests one at a time, so a per-op timer fires on queue wait alone; this
 * clock restarts whenever any op settles, and only a signer that has stopped
 * answering is nudged.
 */
class Nudger {
  readonly #isBunkerConnected: (() => boolean) | undefined;
  readonly #remote: boolean;
  readonly hardTimeoutMs: number;
  readonly #pending = new Set<PendingOp>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #shown: { dismiss: () => void } | undefined;
  #lastShownAt = -Infinity;

  constructor(isBunkerConnected: (() => boolean) | undefined, remote: boolean, hardTimeoutMs: number) {
    this.#isBunkerConnected = isBunkerConnected;
    this.#remote = remote;
    this.hardTimeoutMs = hardTimeoutMs;
  }

  begin(op: PendingOp): void {
    this.#pending.add(op);
    if (this.#timer === undefined && !this.#shown) this.#arm(NUDGE_DELAY_MS);
  }

  /** `approved`: it resolved with a value, which confirms a nudge actually shown. */
  end(op: PendingOp, approved: boolean): void {
    this.#pending.delete(op);
    this.#disarm();
    if (this.#shown) {
      this.#shown.dismiss();
      this.#shown = undefined;
      if (approved) showSuccessToast(op.opType);
    }
    if (this.#pending.size > 0) this.#arm(NUDGE_DELAY_MS);
  }

  #arm(ms: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#show();
    }, ms);
  }

  #disarm(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #show(): void {
    // The oldest pending op is the one the signer is stuck on.
    const head = this.#pending.values().next().value;
    if (!head) return;
    // Throttled, not dropped: a stall inside the window is nudged when it ends.
    const wait = this.#lastShownAt + NUDGE_THROTTLE_MS - Date.now();
    if (wait > 0) return this.#arm(wait);
    this.#lastShownAt = Date.now();
    this.#shown = showNudgeToast({
      kind: head.kind,
      opType: head.opType,
      isBunkerConnected: this.#isBunkerConnected,
      remote: this.#remote,
      durationMs: this.hardTimeoutMs,
      // The rest are queued behind the stalled one, so skip them all.
      onCancel: () => {
        for (const op of [...this.#pending]) op.cancel();
      },
    });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Run `op` under `nudger`, with a cancel button and a hard timeout. */
async function runWithNudge<T>(
  op: () => Promise<T>,
  nudger: Nudger,
  kind: number | undefined,
  opType: OpType,
): Promise<T> {
  type Outcome =
    | { tag: "value"; value: T }
    | { tag: "error"; error: unknown }
    | { tag: "signal"; signal: Signal };

  const cancelSignal = deferred<typeof CANCEL>();
  const timeoutSignal = deferred<typeof TIMEOUT>();
  const pending: PendingOp = { kind, opType, cancel: () => cancelSignal.resolve(CANCEL) };
  const hardTimer = setTimeout(() => timeoutSignal.resolve(TIMEOUT), nudger.hardTimeoutMs);
  nudger.begin(pending);

  const opOutcome: Promise<Outcome> = op().then(
    (value): Outcome => ({ tag: "value", value }),
    (error): Outcome => ({ tag: "error", error }),
  );

  const signalOutcome: Promise<Outcome> = Promise.race([
    cancelSignal.promise,
    timeoutSignal.promise,
  ]).then((signal): Outcome => ({ tag: "signal", signal }));

  const outcome = await Promise.race([opOutcome, signalOutcome]);
  clearTimeout(hardTimer);
  nudger.end(pending, outcome.tag === "value");

  if (outcome.tag === "value") return outcome.value;

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
 * once it has answered nothing for 4s, a hard timeout, and one confirmation
 * when a shown nudge's stall ends in a signature. nip04/
 * nip44 pass through un-nudged (bulk decrypts are consent-gated by
 * bulkDecryptGate). `signPsbt` and AppSigner's `isDecryptCached` are forwarded.
 *
 * @param isBunkerConnected - Checked at nudge time; false shows a relay-unreachable warning.
 * @param opts.remote - A NIP-46 signer: the nudge explains where to approve.
 * @param opts.hardTimeoutMs - Overrides the 65s fence (a NIP-46 signer waits longer).
 */
export function signerWithNudge(
  signer: NostrSigner,
  isBunkerConnected?: () => boolean,
  opts?: { remote?: boolean; hardTimeoutMs?: number },
): NostrSigner {
  const nudger = new Nudger(isBunkerConnected, opts?.remote ?? false, opts?.hardTimeoutMs ?? HARD_TIMEOUT_MS);
  function run<T>(op: () => Promise<T>, kind: number | undefined, opType: OpType): Promise<T> {
    return runWithNudge(op, nudger, kind, opType);
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

  unwrapped.set(wrapped, signer);
  return wrapped;
}

const unwrapped = new WeakMap<NostrSigner, NostrSigner>();

/**
 * The signer under a {@link signerWithNudge} wrapper, for signs the user didn't
 * start (a background NIP-42 AUTH): those must not ask them to approve anything.
 */
export function withoutNudge(signer: NostrSigner): NostrSigner {
  return unwrapped.get(signer) ?? signer;
}

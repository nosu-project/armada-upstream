// AbortSignal.any/timeout fallbacks for old Android System WebViews (`any` is
// Chromium 116+). Installed first by `src/polyfills.ts`; no-op where native.
// Unlike native `any`, the fallback holds sources strongly until one aborts;
// call sites always pair with a timeout, bounding that.

/** `AbortSignal.any`: a signal that aborts when any of `signals` does. */
export function abortSignalAny(signals: Iterable<AbortSignal>): AbortSignal {
  const sources = [...signals];
  const controller = new AbortController();

  for (const source of sources) {
    if (source.aborted) {
      controller.abort(source.reason);
      return controller.signal;
    }
  }

  const detach = () => {
    for (const source of sources) source.removeEventListener("abort", onAbort);
  };
  function onAbort(this: AbortSignal) {
    detach();
    controller.abort(this.reason);
  }
  for (const source of sources) source.addEventListener("abort", onAbort);

  return controller.signal;
}

/** `AbortSignal.timeout`: a signal that aborts with a `TimeoutError` after `ms`. */
export function abortSignalTimeout(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(new DOMException("signal timed out", "TimeoutError"));
  }, ms);
  return controller.signal;
}

/**
 * Fill in `AbortSignal.any` / `AbortSignal.timeout` where the runtime lacks
 * them. Idempotent, and a no-op wherever the native statics exist.
 */
export function installAbortSignalPolyfills(): void {
  if (typeof AbortSignal === "undefined") return;
  const statics = AbortSignal as unknown as Record<string, unknown>;
  if (typeof statics.timeout !== "function") statics.timeout = abortSignalTimeout;
  if (typeof statics.any !== "function") statics.any = abortSignalAny;
}

// AbortSignal statics for WebViews that predate them.
//
// The client composes nearly every relay read's deadline as
// `AbortSignal.any([signal, AbortSignal.timeout(ms)])` — some eighty call
// sites. `AbortSignal.any` reached Chromium in 116 (Aug 2023), and Android
// System WebView is updated independently of the OS, so a phone can run a
// current Android with a WebView that lacks it: a stock Android 13 Samsung
// was reported failing "Use this relay" with `AbortSignal.any is not a
// function` out of the portable-state mirror. `AbortSignal.timeout` is older
// (Chromium 103) but sits in the same expression, so a WebView old enough to
// miss one may miss the other; both are filled here.
//
// Installed by `src/polyfills.ts`, which `main.tsx` imports FIRST so the
// statics exist before any module that reads them evaluates. Nothing is
// touched where the native implementation exists — the polyfill is not a
// replacement, only a fallback — so evergreen browsers, Electron and the test
// runtime (Node 22) never see it.
//
// The one behavioural gap: the native `any` holds its sources weakly, so a
// long-lived source signal does not retain every dependent ever derived from
// it. The fallback registers a listener per call and removes it when ANY
// source aborts. Every call site pairs the long-lived signal with a timeout,
// so the listener lives at most as long as that deadline.

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

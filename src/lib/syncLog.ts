/**
 * Dev-only timestamped trace of the Concord sync pipeline. Toggle with
 * `localStorage.debugSync = '1'|'0'`; on by default in dev. Times are seconds since load.
 */

const t0 = Date.now();

function enabled(): boolean {
  try {
    const v = localStorage.getItem("debugSync");
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
  } catch {
    /* localStorage may be unavailable */
  }
  return import.meta.env?.DEV ?? false;
}

/** One timeline line: `[sync +12.34s] tag — message {data}`. */
export function logSync(tag: string, message: string, data?: unknown): void {
  if (!enabled()) return;
  const t = ((Date.now() - t0) / 1000).toFixed(2);
  if (data === undefined) {
    console.log(`%c[sync +${t}s]%c ${tag} — ${message}`, "color:#c586ff;font-weight:bold", "color:inherit");
  } else {
    console.log(
      `%c[sync +${t}s]%c ${tag} — ${message}`,
      "color:#c586ff;font-weight:bold",
      "color:inherit",
      data,
    );
  }
}

/** Milliseconds elapsed since `start` (a `Date.now()` sample), for log lines. */
export function sinceMs(start: number): string {
  return `${Date.now() - start}ms`;
}

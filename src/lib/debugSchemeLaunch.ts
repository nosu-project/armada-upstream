/**
 * DEBUG PROBE — external-scheme (custom-protocol) launch tracer.
 *
 * Chrome shows its "open other apps & services on this device" prompt whenever
 * the page navigates to a non-http(s) scheme mapped to an installed app
 * (`lightning:`, `bitcoin:`, `spotify:`, `mailto:`, …). External-protocol
 * launches never hit the network and Chrome usually doesn't log them, so they
 * can't be seen in the Network or Console tabs on their own.
 *
 * This probe intercepts every route a launch can take — `window.open`,
 * `location.assign` / `location.replace`, an `<a>` click, or an explicit
 * {@link logSchemeLaunch} call at a known hand-off site — and prints the URI
 * plus a full `console.trace` stack, so the exact component / handler that
 * triggered the prompt is visible in the console.
 *
 * TEMPORARY: remove once the offending path is identified.
 */

// Schemes that never raise the external-app prompt (normal web navigation).
const ALLOWED = new Set(["http", "https", "ws", "wss", "blob", "data", "about", "javascript"]);

function schemeOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  return m ? m[1].toLowerCase() : undefined;
}

/** Log (with a stack trace) any URL whose scheme would launch an external app. */
export function logSchemeLaunch(url: string, source: string): void {
  const scheme = schemeOf(url);
  if (!scheme || ALLOWED.has(scheme)) return;
  console.warn(`[scheme-launch] via ${source} → ${scheme}: ${url.slice(0, 160)}`);
  console.trace(`[scheme-launch] stack (${scheme} from ${source})`);
}

let installed = false;

/** Install the global interceptors. Idempotent; safe to call once at startup. */
export function installExternalSchemeProbe(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // window.open(...)
  const origOpen = window.open.bind(window);
  window.open = function (url?: string | URL, ...rest: unknown[]) {
    if (url != null) logSchemeLaunch(String(url), "window.open");
    return (origOpen as (u?: string | URL, ...r: unknown[]) => Window | null)(url, ...rest);
  } as typeof window.open;

  // location.assign(...) / location.replace(...)
  for (const method of ["assign", "replace"] as const) {
    try {
      const orig = window.location[method].bind(window.location);
      window.location[method] = ((url: string | URL) => {
        logSchemeLaunch(String(url), `location.${method}`);
        return orig(url as string);
      }) as typeof window.location.assign;
    } catch {
      // Some browsers make these read-only; the explicit call sites still cover it.
    }
  }

  // Anchor clicks with a custom-scheme href (capture phase, catches nested targets).
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (a) logSchemeLaunch(a.getAttribute("href") ?? "", "a-click");
    },
    true,
  );

  console.info("[scheme-launch] probe installed — watching for external-app launches");
}

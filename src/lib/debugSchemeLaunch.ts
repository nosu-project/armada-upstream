/**
 * DEBUG PROBE — external-scheme (custom-protocol) launch tracer.
 *
 * Chrome shows its "open other apps & services on this device" prompt whenever
 * the page (or a subframe / auto-inserted element) navigates to a non-http(s)
 * scheme mapped to an installed app (`lightning:`, `bitcoin:`, `spotify:`, …).
 * External-protocol launches never hit the network and Chrome usually doesn't
 * log them, so they can't be seen in the Network or Console tabs on their own.
 *
 * This probe intercepts every route a launch can take:
 *   - `window.open`
 *   - `location.assign` / `location.replace`
 *   - `<a>` clicks (real + programmatic `.click()`)
 *   - `<form>` submits
 *   - any element inserted with a custom-scheme `src`/`href`/`data`/`action`
 *     (a `<iframe src="bitcoin:…">` / auto-injected link), via MutationObserver
 *   - explicit {@link logSchemeLaunch} calls at known hand-off sites
 *
 * It also logs the src of EVERY <iframe> that renders, so we can see exactly
 * which embeds a page mounts (an iframe's own internal navigation to a scheme
 * can't be intercepted from here — but knowing the iframe is present points
 * straight at it).
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
  console.warn(`[scheme-launch] via ${source} → ${scheme}: ${url.slice(0, 200)}`);
  console.trace(`[scheme-launch] stack (${scheme} from ${source})`);
}

/** Scan an element's URL-bearing attributes for a custom scheme. */
function scanEl(el: Element, source: string): void {
  for (const attr of ["src", "href", "data", "action", "formaction"] as const) {
    const v = el.getAttribute?.(attr);
    if (v) logSchemeLaunch(v, `${source}[${el.tagName.toLowerCase()}.${attr}]`);
  }
  if (el.tagName === "IFRAME") {
    const src = el.getAttribute("src") ?? "(no src)";
    console.info(`[scheme-launch] iframe rendered: ${src.slice(0, 200)}`);
  }
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

  // Programmatic anchor .click() (detached anchors never bubble to document).
  try {
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      logSchemeLaunch(this.getAttribute("href") ?? "", "anchor.click()");
      return origClick.call(this);
    };
  } catch { /* */ }

  // Real clicks + form submits (capture phase, catches nested targets).
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (a) logSchemeLaunch(a.getAttribute("href") ?? "", "a-click");
    },
    true,
  );
  document.addEventListener(
    "submit",
    (e) => {
      const f = e.target as HTMLFormElement | null;
      if (f?.getAttribute) logSchemeLaunch(f.getAttribute("action") ?? "", "form-submit");
    },
    true,
  );

  // Watch the DOM for auto-inserted scheme elements + log every iframe rendered.
  try {
    const obs = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === "attributes" && rec.target instanceof Element) {
          scanEl(rec.target, "mutate");
        }
        for (const node of rec.addedNodes) {
          if (!(node instanceof Element)) continue;
          scanEl(node, "added");
          node.querySelectorAll?.("iframe,a[href],object,embed,form[action]").forEach((el) => scanEl(el, "added-descendant"));
        }
      }
    });
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "href", "data", "action", "formaction"],
    });
  } catch { /* */ }

  console.info("[scheme-launch] probe installed (v2) — watching launches + iframes");
}

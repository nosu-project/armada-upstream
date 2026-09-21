import { isLocalNetworkUrl } from "@/lib/sanitizeUrl";

/**
 * Where a piece of remote media is loaded FROM, decided in one place.
 *
 * An `<img>` is a request from the viewer's own address to whichever host the
 * sender named, so a message containing an image is a message that learns the
 * IP of everyone who scrolls past it. Nothing about the bytes distinguishes a
 * picture from a logger, and no referrer policy or CSP touches the TCP
 * connection. The one control is a PROXY: a URI template (`{href}`, Ditto's
 * convention) that makes the proxy's address the one the sender's host sees.
 * This module owns that decision for chat attachments, avatars, custom emoji,
 * link-preview thumbnails and the encrypted Concord icons alike; the hooks and
 * the native ports apply it, they do not restate it.
 *
 * OFF by default — the app config ships an empty template, so media loads
 * directly from the host the sender named until the user turns proxying on in
 * settings, which sets the public proxy Ditto ships (a byte-for-byte
 * pass-through so ciphertext, hash-verified blobs and range requests all
 * survive it), itself replaceable. An empty template is proxying off. A
 * loopback/private address is never proxied (a public proxy cannot reach it)
 * and never loaded directly (it trips Chrome's Local Network Access prompt), so
 * it resolves to nothing.
 *
 * A policy may instead carry a POOL of proxy templates (`proxies`), parsed from
 * the user's list of proxies entered in settings (one per line, see
 * `parseProxyList`). The web client's cross-server fallback
 * (`routeMediaCandidates`) then rotates a URL across the pool — spreading which
 * proxy sees a given image, and falling to the next when one fails to load.
 * `proxy` is still the single-value floor the single-image sites (`mediaSrc`)
 * and the background writers read (they do not rotate); it holds the pool's
 * first entry.
 *
 * Pure. The Kotlin and Swift ports (`MediaPolicy.java`, `MediaPolicy.swift`)
 * apply the same rule to the background avatar fetch; keep the three in step.
 * They do NOT rotate — they carry the primary proxy only — but the template
 * normalization (`normalizeProxy`) is shared and must stay identical.
 */

/** Ditto's default CORS proxy: a byte-for-byte pass-through with a shared cache. */
export const DEFAULT_MEDIA_PROXY = "https://proxy.shakespeare.diy/?url={href}";

export interface MediaPolicy {
  /** Proxy URI template (see {@link normalizeMediaProxy}); empty = no proxy. */
  proxy: string;
  /**
   * The rotation pool for the web client's fallback path (see
   * {@link routeMediaCandidates}). Set only when the user entered more than one
   * proxy, where it is the whole list; absent or empty falls back to
   * {@link proxy} alone. Never populated when {@link proxy} is empty (proxying
   * off means direct loads). Not carried across the native bridge.
   */
  proxies?: readonly string[];
}

/** How many templates a fetched rotation list may contribute, at most. */
export const MAX_PROXY_POOL = 32;

/**
 * The policy as it crosses a bridge — to the service worker's sealed config,
 * the Android service's preferences and the iOS extension's config file — so
 * the three background writers proxy a sender's avatar exactly as the page
 * does. Plain JSON: one string.
 */
export interface MediaPolicyConfig {
  proxy: string;
}

/**
 * The protective fallback a reader with no config in reach AT ALL applies: the
 * default proxy on. This is NOT the app's own default (which is proxying OFF —
 * see `defaultConfig.mediaProxies`); it is the floor for a background writer whose
 * config is missing or was sealed before this field existed, so a legacy install
 * that had proxying on still proxies a stranger's avatar rather than leaking its
 * IP. A fresh install writes `{ proxy: "" }` through the bridge and never reaches
 * this.
 */
export function defaultMediaPolicy(): MediaPolicy {
  return { proxy: DEFAULT_MEDIA_PROXY };
}

/** A bridge config back into a policy, tolerating a missing or partial one. */
export function mediaPolicyFromConfig(config: Partial<MediaPolicyConfig> | undefined): MediaPolicy {
  if (!config || typeof config.proxy !== "string") return defaultMediaPolicy();
  return { proxy: normalizeMediaProxy(config.proxy) };
}

/**
 * Minimal RFC 6570 expansion, the subset Ditto's templates use: `{var}`
 * percent-encodes, `{+var}` keeps reserved characters. Unknown variables
 * expand to nothing.
 */
export function fillUriTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{(\+?)([A-Za-z0-9_]+)\}/g, (_m, plus: string, name: string) => {
    const value = vars[name];
    if (value === undefined) return "";
    return plus ? encodeURI(value) : encodeURIComponent(value);
  });
}

/**
 * The form a proxy template is stored in: trimmed, `http(s)` only, and with a
 * placeholder — appended when the user typed a bare prefix, so both spellings
 * work. Returns `""` for anything unusable, which the policy reads as "no
 * proxy".
 *
 * A bare prefix that ends in `=` is a query PARAMETER value
 * (`https://p.example/?url=`), which takes the percent-encoded `{href}`.
 * Anything else — a bare `?` (`https://proxy.corsfix.com/?`) or a path — takes
 * the target URL RAW via `{+href}`, which is what corsfix-style proxies want
 * and what percent-encoding was breaking. A template that already spells its
 * own placeholder is left exactly as typed.
 */
export function normalizeMediaProxy(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  try {
    const probe = new URL(fillUriTemplate(trimmed, { href: "https://example.com/x" }));
    if (probe.protocol !== "https:" && probe.protocol !== "http:") return "";
  } catch {
    return "";
  }
  if (/\{\+?href\}/.test(trimmed)) return trimmed;
  return trimmed.endsWith("=") ? `${trimmed}{href}` : `${trimmed}{+href}`;
}

/**
 * The user's entered proxy list (see `AppConfig.mediaProxies`) parsed into
 * normalized templates: one per line, `,` also splitting, `#` comments and
 * blanks dropped, each run through {@link normalizeMediaProxy}, deduped, and
 * capped at {@link MAX_PROXY_POOL} so a long list cannot unbound the fallback
 * walk.
 */
export function parseProxyList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/[\r\n,]+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = normalizeMediaProxy(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_PROXY_POOL) break;
  }
  return out;
}

/** The lowercase hostname of a URL, or undefined when it has none. */
export function mediaHost(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** `blob:` and `data:` carry their own bytes; nothing is fetched. */
function isInlineSource(url: string): boolean {
  return /^(?:blob|data):/i.test(url);
}

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * The URL to load `url` through `proxy`, or `url` itself when proxying makes no
 * sense: inline sources, non-http schemes, an empty template, and a URL already
 * on the proxy's own origin (a stored proxied URL must not be wrapped twice).
 */
export function proxyMediaUrl(url: string, proxy: string): string {
  if (!proxy || isInlineSource(url) || !isHttp(url)) return url;
  // The template's braces are not URL characters, so the proxy's own host is
  // read off a filled probe rather than the template itself.
  const proxyHost = mediaHost(fillUriTemplate(proxy, { href: "https://example.com/x" }));
  if (proxyHost && mediaHost(url) === proxyHost) return url;
  return fillUriTemplate(proxy, { href: url });
}

/**
 * The `src` to load `url` from under `policy`, or undefined when it must not be
 * loaded at all: a loopback/private address a public proxy cannot reach and a
 * direct load would leak. Inline sources pass through; an http(s) host is
 * proxied when a proxy is set and loaded directly when it is not.
 *
 * For the one-image sites (a notification icon, a CSS background, a banner)
 * that show nothing rather than a placeholder.
 */
export function mediaSrc(url: string | undefined, policy: MediaPolicy): string | undefined {
  if (!url) return undefined;
  if (isInlineSource(url) || !isHttp(url)) return url;
  if (isLocalNetworkUrl(url)) return undefined;
  return policy.proxy ? proxyMediaUrl(url, policy.proxy) : url;
}

/** The rotation pool a policy resolves to: the explicit pool, or the primary alone. */
function effectiveProxies(policy: MediaPolicy): readonly string[] {
  if (policy.proxies && policy.proxies.length > 0) return policy.proxies;
  return policy.proxy ? [policy.proxy] : [];
}

/** A stable 32-bit hash (FNV-1a), so a URL's rotation start is deterministic. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The ordered proxied forms of `url` across `proxies`: every proxy, starting at
 * a per-URL rotation offset so which proxy is tried FIRST varies by image
 * (spreading load off any one host) while the rest follow as fallbacks. A URL
 * already on one of the pool's own hosts is a stored proxied URL and is
 * returned once, unwrapped — the same guard {@link proxyMediaUrl} applies.
 */
function proxyRotation(url: string, proxies: readonly string[]): string[] {
  const urlHost = mediaHost(url);
  const proxyHosts = proxies.map((p) => mediaHost(fillUriTemplate(p, { href: "https://example.com/x" })));
  if (urlHost && proxyHosts.some((h) => h === urlHost)) return [url];
  const start = urlHost ? hashString(url) % proxies.length : 0;
  const out: string[] = [];
  for (let i = 0; i < proxies.length; i++) {
    out.push(fillUriTemplate(proxies[(start + i) % proxies.length], { href: url }));
  }
  return out;
}

/**
 * Route a whole candidate list (see `mediaCandidates`) under one policy: each
 * source in the form it should load in — proxied when a proxy is set, direct
 * otherwise — with local-network candidates dropped and duplicates collapsed.
 *
 * With a rotation pool set (`policy.proxies`), each http(s) candidate is
 * expanded to its proxied form through every proxy, rotated per URL, so the
 * `<img>` fallback walk (`useSourceWalk`) tries the next proxy when one fails.
 */
export function routeMediaCandidates(
  candidates: readonly string[],
  policy: MediaPolicy,
): { sources: string[] } {
  const proxies = effectiveProxies(policy);
  const sources: string[] = [];
  const seen = new Set<string>();
  const push = (src: string | undefined) => {
    if (!src || seen.has(src)) return;
    seen.add(src);
    sources.push(src);
  };
  for (const candidate of candidates) {
    if (isInlineSource(candidate) || !isHttp(candidate)) {
      push(candidate);
      continue;
    }
    if (isLocalNetworkUrl(candidate)) continue;
    if (proxies.length === 0) {
      push(candidate);
      continue;
    }
    for (const variant of proxyRotation(candidate, proxies)) push(variant);
  }
  return { sources };
}

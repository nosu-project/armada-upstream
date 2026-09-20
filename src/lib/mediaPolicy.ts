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
 * ON by default — the public proxy Ditto ships, a byte-for-byte pass-through so
 * ciphertext, hash-verified blobs and range requests all survive it — user
 * configurable, and clearable: an empty template turns proxying off and media
 * loads directly from the host the sender named. A loopback/private address is
 * never proxied (a public proxy cannot reach it) and never loaded directly (it
 * trips Chrome's Local Network Access prompt), so it resolves to nothing.
 *
 * Pure. The Kotlin and Swift ports (`MediaPolicy.java`, `MediaPolicy.swift`)
 * apply the same rule to the background avatar fetch; keep the three in step.
 */

/** Ditto's default CORS proxy: a byte-for-byte pass-through with a shared cache. */
export const DEFAULT_MEDIA_PROXY = "https://proxy.shakespeare.diy/?url={href}";

export interface MediaPolicy {
  /** Proxy URI template (see {@link normalizeMediaProxy}); empty = no proxy. */
  proxy: string;
}

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
 * The policy a reader with no config in reach applies: the default proxy on.
 * This is what the push service worker runs under, so a config sealed before
 * this field existed still proxies a stranger's avatar.
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
 * `{href}` placeholder — appended when the user typed a bare prefix like
 * `https://proxy.example/?url=`, so both spellings work. Returns `""` for
 * anything unusable, which the policy reads as "no proxy".
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
  return /\{\+?href\}/.test(trimmed) ? trimmed : `${trimmed}{href}`;
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

/**
 * Route a whole candidate list (see `mediaCandidates`) under one policy: each
 * source in the form it should load in — proxied when a proxy is set, direct
 * otherwise — with local-network candidates dropped and duplicates collapsed.
 */
export function routeMediaCandidates(
  candidates: readonly string[],
  policy: MediaPolicy,
): { sources: string[] } {
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const src = mediaSrc(candidate, policy);
    if (!src || seen.has(src)) continue;
    seen.add(src);
    sources.push(src);
  }
  return { sources };
}

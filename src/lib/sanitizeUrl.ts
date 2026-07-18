/**
 * Validate that a string is a well-formed HTTP(S) URL.
 *
 * Returns the normalised `href` when valid, or `undefined` otherwise.
 * This **must** be used whenever a URL originates from untrusted Nostr
 * event data (tags, metadata fields, etc.) and will be placed into an
 * `href`, `window.open()`, or `openUrl()` call.  Without this check a
 * malicious `javascript:` URI could execute arbitrary code.
 *
 * Armada note: plain `http:` is allowed (unlike Ditto) because internal
 * infrastructure commonly serves over private hostnames without TLS.
 */
export function sanitizeUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.href;
    }
  } catch {
    // not a valid URL
  }
  return undefined;
}

/**
 * Whether a URL targets a loopback / local / private-network address.
 *
 * When a public HTTPS page (armada.buzz) loads a subresource from such an
 * address, Chrome's Local Network Access gate prompts the user with
 * "… wants to access other apps and services on this device". Untrusted event
 * data (custom-emoji URLs, avatars, media) can carry a `http://localhost:…` or
 * `http://192.168.x.x/…` URL — usually a leaked dev instance — so anything that
 * turns such a URL into an `<img>`/`fetch` MUST refuse it, or every viewer who
 * renders it gets that prompt.
 */
export function isLocalNetworkUrl(raw: string | undefined | null): boolean {
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  const h = host.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true; // loopback / private / "this host"
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local
  }
  if (/^f[cd][0-9a-f]*:/.test(h)) return true; // IPv6 unique-local fc00::/7
  if (/^fe[89ab][0-9a-f]*:/.test(h)) return true; // IPv6 link-local fe80::/10
  return false;
}

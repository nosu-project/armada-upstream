/**
 * Authenticated media loading for Buzz relays.
 *
 * Buzz relays serve media (avatars, inline images, video) as Blossom blobs at
 * `https://<host>/media/<64-hex-sha256>[.thumb][.ext]`, but with BUD-11 auth
 * REQUIRED on GET: the request must carry `Authorization: Nostr <base64 of a
 * signed kind:24242 event>` or the relay answers `401`. A plain `<img src>`
 * can't set that header, so Buzz-hosted images never load through the normal
 * path.
 *
 * This module bridges the gap: for URLs on a KNOWN Buzz media host it fetches
 * the blob with a signed GET auth header and hands back an object URL an
 * `<img>`/`<video>` can use. The auth event is **server-scoped** (`["server",
 * host]`) rather than blob-scoped, so ONE token authorizes every blob on that
 * host (BUD-11 §5 / Buzz `verify_blossom_get_auth` accepts a matching `server`
 * tag), and it's cached per host and re-minted well before it expires.
 *
 * Only hosts we've positively identified as Buzz relays (see
 * `registerBuzzMediaHost`, driven by `useIsBuzzRelay`) are treated this way —
 * external Blossom URLs (nostr.build, void.cat, …) are left untouched so their
 * plain `<img src>` keeps working.
 */

import { N64 } from "@nostrify/nostrify/utils";

import type { NostrSigner } from "@nostrify/nostrify";

// ─── Host registry ────────────────────────────────────────────────────────

/** Lowercased hosts (e.g. "soapbox.communities.buzz.xyz") known to be Buzz. */
const buzzMediaHosts = new Set<string>();

/** Bumped whenever the host set grows, so hooks can re-evaluate `isBuzzMediaUrl`. */
let hostsVersion = 0;
const hostsListeners = new Set<() => void>();

function hostOf(url: string): string | null {
  try {
    // `new URL` keeps the host for ws(s):// and http(s):// alike, so a relay
    // websocket URL and its media http(s) URL resolve to the same host.
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Mark a host (from any ws/http URL on it) as a Buzz media host. Idempotent;
 * notifies subscribers only when the set actually grows so `useSyncExternalStore`
 * consumers don't churn.
 */
export function registerBuzzMediaHost(url: string | undefined): void {
  if (!url) return;
  const host = hostOf(url);
  if (!host || buzzMediaHosts.has(host)) return;
  buzzMediaHosts.add(host);
  hostsVersion += 1;
  for (const listener of hostsListeners) listener();
}

/** Subscribe to host-registry growth (for `useSyncExternalStore`). */
export function subscribeBuzzMediaHosts(listener: () => void): () => void {
  hostsListeners.add(listener);
  return () => {
    hostsListeners.delete(listener);
  };
}

/** Monotonic snapshot of the host registry (for `useSyncExternalStore`). */
export function getBuzzMediaHostsVersion(): number {
  return hostsVersion;
}

/** Buzz media path: `/media/<64-hex>` optionally `.thumb` and/or an extension. */
const MEDIA_PATH_RE = /^\/media\/[0-9a-f]{64}(?:\.thumb)?(?:\.[a-z0-9]+)?$/i;

/** Whether `url` is a media blob on a known Buzz host (so it needs GET auth). */
export function isBuzzMediaUrl(url: string | undefined): boolean {
  if (!url) return false;
  const host = hostOf(url);
  if (!host || !buzzMediaHosts.has(host)) return false;
  try {
    return MEDIA_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// ─── Current signer ─────────────────────────────────────────────────────────

/**
 * The logged-in user's signer, published once at app root (see NostrSync) so
 * the many render sites that resolve media don't each pull `useCurrentUser`.
 * `undefined` when logged out — media auth then can't be minted and callers
 * fall back to the plain (401-ing) URL.
 */
let currentSigner: NostrSigner | undefined;

export function setBuzzMediaSigner(signer: NostrSigner | undefined): void {
  currentSigner = signer;
}

// ─── GET auth tokens (server-scoped, cached per host) ───────────────────────

/**
 * How long a minted token is reused before re-minting. The relay accepts a
 * token whose `created_at` is within the last hour (and whose `expiration` is
 * still future); re-minting at 30 min keeps a comfortable margin so an in-flight
 * request never races the boundary.
 */
const TOKEN_REFRESH_MS = 30 * 60 * 1000;
/** Lifetime stamped into the `expiration` tag (1h). */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

interface CachedToken {
  header: string;
  mintedAt: number;
  /** Pubkey the token was signed by, so a login change re-mints. */
  pubkey: string;
}

const tokenByHost = new Map<string, CachedToken>();

/** In-flight mints, so concurrent image loads on a host share one signature. */
const mintInFlight = new Map<string, Promise<string>>();

async function mintGetToken(signer: NostrSigner, host: string): Promise<string> {
  const now = Date.now();
  const event = await signer.signEvent({
    kind: 24242,
    // BUD-11 requires a non-empty, human-readable content string.
    content: "Get media",
    created_at: Math.floor(now / 1000),
    tags: [
      ["t", "get"],
      ["server", host],
      ["expiration", Math.floor((now + TOKEN_LIFETIME_MS) / 1000).toString()],
    ],
  });
  const header = `Nostr ${N64.encodeEvent(event)}`;
  tokenByHost.set(host, { header, mintedAt: now, pubkey: event.pubkey });
  return header;
}

async function getGetAuthHeader(
  signer: NostrSigner,
  host: string,
  pubkey: string,
): Promise<string> {
  const cached = tokenByHost.get(host);
  if (
    cached &&
    cached.pubkey === pubkey &&
    Date.now() - cached.mintedAt < TOKEN_REFRESH_MS
  ) {
    return cached.header;
  }
  const existing = mintInFlight.get(host);
  if (existing) return existing;
  const promise = mintGetToken(signer, host).finally(() => {
    mintInFlight.delete(host);
  });
  mintInFlight.set(host, promise);
  return promise;
}

// ─── Object-URL cache (bounded by total bytes, LRU) ─────────────────────────

/** Max total bytes kept alive as object URLs (~96 MB). */
const MAX_CACHED_BYTES = 96 * 1024 * 1024;
/** Keep a revoked URL alive briefly so a still-mounted `<img>` can re-resolve. */
const REVOKE_GRACE_MS = 30_000;

interface Entry {
  promise: Promise<string>;
  bytes: number;
  url?: string;
}

/** url → entry. Insertion order = LRU order. */
const cache = new Map<string, Entry>();
let totalBytes = 0;

function touch(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
}

function evictToBudget(keep: string): void {
  for (const [key, entry] of cache) {
    if (totalBytes <= MAX_CACHED_BYTES) break;
    if (key === keep) continue;
    cache.delete(key);
    totalBytes -= entry.bytes;
    const url = entry.url;
    if (url) setTimeout(() => URL.revokeObjectURL(url), REVOKE_GRACE_MS);
  }
}

/**
 * Fetch a Buzz media blob with a signed BUD-11 GET header and return an object
 * URL for it. Results are cached per URL (shared between an inline thumbnail
 * and the lightbox, and across re-renders). Throws when logged out (no signer)
 * or on fetch failure so callers can fall back to a plain link.
 */
export async function resolveBuzzMediaObjectURL(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const signer = currentSigner;
  if (!signer) throw new Error("Buzz media: no signer to mint GET auth");

  const existing = cache.get(url);
  if (existing) {
    touch(url, existing);
    return existing.promise;
  }

  const host = hostOf(url);
  if (!host) throw new Error("Buzz media: unparseable URL");

  const entry: Entry = { promise: Promise.resolve(""), bytes: 0 };

  entry.promise = (async () => {
    const pubkey = await signer.getPublicKey();

    const fetchOnce = async (header: string) =>
      fetch(url, { headers: { Authorization: header }, signal });

    let header = await getGetAuthHeader(signer, host, pubkey);
    let res = await fetchOnce(header);
    // A 401/403 most likely means the cached token drifted out of its window;
    // drop it, re-mint once, and retry before giving up.
    if (res.status === 401 || res.status === 403) {
      tokenByHost.delete(host);
      header = await getGetAuthHeader(signer, host, pubkey);
      res = await fetchOnce(header);
    }
    if (!res.ok) throw new Error(`Buzz media fetch failed: HTTP ${res.status}`);

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    if (cache.get(url) === entry) {
      entry.bytes = blob.size;
      entry.url = objectUrl;
      totalBytes += entry.bytes;
      evictToBudget(url);
    }
    return objectUrl;
  })();

  cache.set(url, entry);
  entry.promise.catch(() => {
    if (cache.get(url) === entry) {
      cache.delete(url);
      totalBytes -= entry.bytes;
    }
  });

  return entry.promise;
}

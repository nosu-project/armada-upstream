import { isLocalNetworkUrl, sanitizeUrl } from "@/lib/sanitizeUrl";

import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * App default Blossom media servers (mirrors Ditto's APP_BLOSSOM_SERVERS).
 * Used in addition to the user's kind 10063 server list when
 * `useAppBlossomServers` is enabled (the default), and as the only servers
 * when the user has no list of their own. Order follows BUD-03's "most
 * trusted first" convention.
 *
 * Deployment-configurable via `VITE_APP_BLOSSOM_SERVERS` (comma-separated
 * http(s) origins), mirroring `VITE_APP_RELAYS`: a hosted/self-hosted build
 * bakes in its own media servers, and the shipped APK/desktop builds can point
 * at whatever the operator chooses. Falls back to the public Armada/Ditto
 * media servers when unset or empty.
 */
const DEFAULT_APP_BLOSSOM_SERVERS =
  "https://blossom.ditto.pub/,https://blossom.dreamith.to/,https://blossom.primal.net/";

export const APP_BLOSSOM_SERVERS: string[] = (
  import.meta.env.VITE_APP_BLOSSOM_SERVERS || DEFAULT_APP_BLOSSOM_SERVERS
)
  .split(",")
  .map((url: string) => normalizeBlossomServerUrl(url))
  .filter((url: string | null): url is string => url !== null);

/**
 * The user's personal Blossom server list, mirroring Ditto's
 * BlossomServerMetadata. `servers` is synced bidirectionally with the user's
 * kind 10063 event; `updatedAt` is the event's `created_at` (0 = never
 * synced), used so a stale relay read never clobbers a fresh local edit.
 */
export interface BlossomServerMetadata {
  /** Ordered server URLs (most trusted/reliable first per BUD-03). */
  servers: string[];
  /** Unix timestamp of the last update (from kind 10063 created_at). */
  updatedAt: number;
  /** Winning kind-10063 id, for NIP-01's lower-id same-second tiebreak. */
  eventId?: string;
}

/** Parse a kind 10063 Blossom server list event into validated server URLs. */
export function parseBlossomServerList(event: Pick<NostrRumor, "tags">): string[] {
  return event.tags
    .filter(([name]) => name === "server")
    .map(([, url]) => url)
    .filter((url) => {
      try {
        new URL(url);
        return true;
      } catch {
        return false;
      }
    });
}

/**
 * Normalize a Blossom server URL for storage/publishing: require http(s),
 * default bare hostnames to https, strip search/hash, ensure a trailing
 * slash. Returns null when the input isn't a usable server URL.
 */
export function normalizeBlossomServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.search = "";
    url.hash = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    return null;
  }
}

/** Normalize a Blossom server URL for deduplication. */
function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, "");
}

/**
 * Get the effective Blossom server list based on user settings. Mirrors
 * Ditto's getEffectiveBlossomServers (and Armada's effectiveDmRelays)
 * semantics:
 *
 * - When `useAppBlossomServers` is true, merges the synchronized app-server
 *   set with the user's servers (app first, deduped).
 * - When false, returns only the user's servers, including an intentional
 *   empty set. An explicit off must not silently dial build-time defaults.
 */
export function getEffectiveBlossomServers(
  appServers: string[],
  userMeta: BlossomServerMetadata,
  useAppBlossomServers: boolean,
): string[] {
  if (!useAppBlossomServers) return dedupeServers(userMeta.servers);
  return dedupeServers([...appServers, ...userMeta.servers]);
}

/**
 * A Blossom content-addressed path: a leading `/<sha256>` (64 hex), optionally
 * followed by an extension (`/<sha256>.png`) some servers keep. The `\b` after
 * the hash tolerates the extension without matching a longer hex-ish path.
 */
export const BLOSSOM_SHA256_PATH_REGEX = /^\/[a-f0-9]{64}\b/i;

/**
 * Given a media URL and the effective server list, return the SAME blob served
 * from every OTHER server, for read-side redundancy (mirrors Ditto's
 * useBlossomFallback). A blob uploaded via {@link getEffectiveBlossomServers}
 * is content-addressed and mirrored (BUD-04) across the list, so swapping the
 * origin onto another server's copy is a valid retry when one server is down or
 * hasn't finished mirroring.
 *
 * Only applies to content-addressed URLs (`/<sha256>[.ext]`): an arbitrary
 * external image has no equivalent elsewhere, so it returns `[]`. Origins are
 * deduped and the source URL's own origin is excluded.
 */
export function blossomFallbackUrls(url: string, servers: readonly string[]): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (!BLOSSOM_SHA256_PATH_REGEX.test(parsed.pathname)) return [];

  const seen = new Set<string>([parsed.origin]);
  const out: string[] = [];
  for (const server of servers) {
    let origin: string;
    try {
      origin = new URL(server).origin;
    } catch {
      continue;
    }
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(`${origin}${parsed.pathname}${parsed.search}`);
  }
  return out;
}

/**
 * The ordered list of sources to try for one media reference — the ONE place
 * that order is decided, whether the walk is then driven by an `<img>`'s
 * `onError`, by a `fetch` loop, or by a service worker.
 *
 * The primary URL first, then the sender's own `fallback` entries, then the
 * same content-addressed blob on every other Blossom server. Declared
 * fallbacks outrank derived mirrors because the sender knows where they
 * actually put the blob, while a mirror is only a guess that a copy exists
 * there (the BUD-04 mirroring the uploader does is best-effort).
 *
 * The declared ones are raw event data, so they are sanitized HERE rather than
 * at each of the dozen places a ref is built — a `javascript:` or LAN fallback
 * must not reach a `fetch` or an `<img src>` by any route. Pure, so the walk is
 * checkable without a renderer.
 */
export function mediaCandidates(
  url: string,
  declaredFallbacks: readonly string[] | undefined,
  blossomServers: readonly string[],
): string[] {
  const seen = new Set<string>([url]);
  const out = [url];
  for (const raw of declaredFallbacks ?? []) {
    const safe = sanitizeUrl(raw);
    if (!safe || isLocalNetworkUrl(safe) || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
  }
  for (const mirror of blossomFallbackUrls(url, blossomServers)) {
    if (seen.has(mirror)) continue;
    seen.add(mirror);
    out.push(mirror);
  }
  return out;
}

/** Deduplicate server URLs by normalized form, preserving order. */
function dedupeServers(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(url);
    }
  }
  return out;
}

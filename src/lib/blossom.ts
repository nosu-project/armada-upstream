import { config } from "@/lib/env";
import { isLocalNetworkUrl, sanitizeUrl } from "@/lib/sanitizeUrl";

import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * App default Blossom servers (mirrors Ditto's APP_BLOSSOM_SERVERS), most
 * trusted first (BUD-03). Overridable via `APP_BLOSSOM_SERVERS`
 * (comma-separated origins).
 */
const DEFAULT_APP_BLOSSOM_SERVERS =
  "https://blossom.ditto.pub/,https://blossom.dreamith.to/,https://blossom.primal.net/";

export const APP_BLOSSOM_SERVERS: string[] = (
  config("APP_BLOSSOM_SERVERS") || DEFAULT_APP_BLOSSOM_SERVERS
)
  .split(",")
  .map((url: string) => normalizeBlossomServerUrl(url))
  .filter((url: string | null): url is string => url !== null);

/**
 * The deployment's preferred Blossom server (`PREFERRED_BLOSSOM_SERVER`):
 * the URL uploads embed when it takes the blob. Empty = no preference.
 */
export const PREFERRED_BLOSSOM_SERVER: string =
  normalizeBlossomServerUrl(config("PREFERRED_BLOSSOM_SERVER") ?? "") ?? "";

/**
 * The user's Blossom server list, synced with their kind 10063 event.
 * `updatedAt` (0 = never synced) keeps a stale relay read from clobbering local edits.
 */
export interface BlossomServerMetadata {
  servers: string[];
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
 * Effective Blossom servers: app servers + user's (deduped) when enabled, else
 * only the user's — even if empty; an explicit off must not dial defaults.
 * A preferred server goes first, joining the list if neither names it: it is
 * a setting of its own, cleared rather than switched off.
 */
export function getEffectiveBlossomServers(
  appServers: string[],
  userMeta: BlossomServerMetadata,
  useAppBlossomServers: boolean,
  preferredServer = "",
): string[] {
  const preferred = normalizeBlossomServerUrl(preferredServer);
  const head = preferred ? [preferred] : [];
  if (!useAppBlossomServers) return dedupeServers([...head, ...userMeta.servers]);
  return dedupeServers([...head, ...appServers, ...userMeta.servers]);
}

/** A content-addressed path `/<sha256>` (64 hex), optionally with an extension. */
export const BLOSSOM_SHA256_PATH_REGEX = /^\/[a-f0-9]{64}\b/i;

/**
 * The same content-addressed blob on every OTHER server (BUD-04 mirrors), for
 * read-side redundancy. `[]` for non-content-addressed URLs.
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
 * The single ordering of sources for a media reference: primary, then the
 * sender's declared fallbacks (they know where the blob is), then Blossom
 * mirrors. Raw URLs are sanitized here so `javascript:`/LAN URLs never reach a fetch.
 */
export function mediaCandidates(
  url: string,
  declaredFallbacks: readonly string[] | undefined,
  blossomServers: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [url, ...(declaredFallbacks ?? [])]) {
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

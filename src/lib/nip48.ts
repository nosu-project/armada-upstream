/** Parsed NIP-48 `proxy` tag: where a bridged message originally came from. */
export interface ProxyInfo {
  /** Protocol marker, verbatim (`web`, `activitypub`, `atproto`, `rss`, …). */
  marker: string;
  /** A service name ("Discord", "ActivityPub") or a hostname. */
  label: string;
  /** The source id, when it's an http(s) URL. */
  url?: string;
  /** Lowercased hostname of `url`, for brand styling. */
  host?: string;
}

const PROTOCOL_LABELS: Record<string, string> = {
  activitypub: 'ActivityPub',
  atproto: 'ATProto',
  rss: 'RSS',
};

/** Web bridges shown by service name instead of hostname. */
const WEB_SERVICE_NAMES: Record<string, string> = {
  'discord.com': 'Discord',
  'discordapp.com': 'Discord',
};

/** Parse an http(s) URL, or null for anything else (`at://`, a bare guid, junk). */
function httpUrl(id: string): URL | null {
  try {
    const url = new URL(id);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * First usable NIP-48 `["proxy", <id>, <marker>]` tag, or null. `web` proxies
 * need an http(s) id, since the URL is all that names the service.
 */
export function parseProxyTag(tags: readonly string[][]): ProxyInfo | null {
  for (const tag of tags) {
    if (tag[0] !== 'proxy') continue;
    const id = tag[1]?.trim();
    const marker = tag[2]?.trim().toLowerCase();
    if (!id || !marker) continue;

    const url = httpUrl(id);
    const host = url?.hostname.replace(/^www\./, '').toLowerCase();

    if (marker === 'web') {
      if (!host) continue;
      return { marker, label: WEB_SERVICE_NAMES[host] ?? host, url: url!.href, host };
    }

    return {
      marker,
      // Unknown markers are shown raw rather than hiding that the message was bridged.
      label: PROTOCOL_LABELS[marker] ?? marker,
      url: url?.href,
      host,
    };
  }

  return null;
}

/** Parsed NIP-48 `proxy` tag: where a bridged message originally came from. */
export interface ProxyInfo {
  /** The protocol marker, verbatim (`web`, `activitypub`, `atproto`, `rss`, …). */
  marker: string;
  /** Badge label — a service name ("Discord", "ActivityPub") or a hostname. */
  label: string;
  /** The source id, when it's an http(s) URL we can open in a browser. */
  url?: string;
  /** Lowercased hostname of `url`, for picking brand styling. */
  host?: string;
}

/** Display names for the protocol markers NIP-48 defines. */
const PROTOCOL_LABELS: Record<string, string> = {
  activitypub: 'ActivityPub',
  atproto: 'ATProto',
  rss: 'RSS',
};

/**
 * Web bridges whose hostname we'd rather show as the service's own name than
 * as a bare domain. Anything unlisted falls back to the hostname.
 */
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
 * Read the NIP-48 `proxy` tag off an event's tags: `["proxy", <id>, <marker>]`,
 * marking a message bridged in from another network.
 *
 * Returns the first usable tag, or null when there is none. Tags missing an id
 * or a marker are skipped, as are `web` proxies whose id isn't an http(s) URL —
 * the URL is the only thing naming the service, so there'd be nothing to show.
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
      // Unknown markers are shown as-is: better a raw protocol name than
      // silently dropping the fact that the message was bridged at all.
      label: PROTOCOL_LABELS[marker] ?? marker,
      url: url?.href,
      host,
    };
  }

  return null;
}

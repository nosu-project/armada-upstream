import { mediaHost } from "@/lib/mediaPolicy";

/**
 * Media hosts loaded without a click even when the viewer hasn't listed them:
 * widely used upload services and the GIF picker's backend, whose access logs a
 * sender can't read. Anything else waits for "Load" under the media hold
 * (`concord/lib/mediaTrust.ts`), since any URL is a request to a host the sender
 * picked. Subdomains count (`i.nostr.build`), so a listed domain must not lapse.
 */
export const KNOWN_MEDIA_HOSTS: readonly string[] = [
  "nostr.build",
  "blossom.primal.net",
  "nostrcheck.me",
  "blossom.band",
  "gifverse.net",
  "i.imgur.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
];

/**
 * Hosts to accept: {@link KNOWN_MEDIA_HOSTS}, the viewer's Blossom servers, and the
 * hosts they trusted themselves (`trustedMediaHosts`, bare hostnames).
 */
export function knownHostSet(
  blossomServers: readonly string[],
  trustedHosts: readonly string[] = [],
): ReadonlySet<string> {
  const hosts = new Set(KNOWN_MEDIA_HOSTS);
  for (const server of blossomServers) {
    const host = mediaHost(server);
    if (host) hosts.add(host);
  }
  for (const host of trustedHosts) {
    const h = normalizeMediaHostInput(host);
    if (h) hosts.add(h);
  }
  return hosts;
}

/** A hostname typed or pasted by the reader (`imgur.com`, `https://i.imgur.com/x`), or undefined. */
export function normalizeMediaHostInput(input: string): string | undefined {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return undefined;
  const host = mediaHost(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
  return host && host.includes(".") ? host : undefined;
}

/** Whether `url` is https on a known host or one of its subdomains. */
export function isKnownMediaHost(url: string, known: ReadonlySet<string>): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  const host = mediaHost(url);
  if (!host) return false;
  for (let h = host; ; ) {
    if (known.has(h)) return true;
    const dot = h.indexOf(".");
    if (dot < 0) return false;
    h = h.slice(dot + 1);
  }
}

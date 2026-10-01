import { mediaHost } from "@/lib/mediaPolicy";

/**
 * Media hosts loaded without a click even when the viewer hasn't listed them:
 * the widely used Nostr upload services. Anything else waits for "Load" under
 * the media hold (`concord/lib/mediaTrust.ts`), since any URL is a request to a
 * host the sender picked. Subdomains count (`i.nostr.build`).
 */
export const KNOWN_MEDIA_HOSTS: readonly string[] = [
  "nostr.build",
  "blossom.primal.net",
  "void.cat",
  "nostrcheck.me",
  "cdn.satellite.earth",
  "blossom.band",
];

/** Hosts to accept: {@link KNOWN_MEDIA_HOSTS} plus the viewer's Blossom servers. */
export function knownHostSet(blossomServers: readonly string[]): ReadonlySet<string> {
  const hosts = new Set(KNOWN_MEDIA_HOSTS);
  for (const server of blossomServers) {
    const host = mediaHost(server);
    if (host) hosts.add(host);
  }
  return hosts;
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

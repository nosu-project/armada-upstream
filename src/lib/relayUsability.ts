/**
 * Which relay URLs this runtime can open (#47). `ws://` is mixed content on
 * secure origins (the APK runs at `https://localhost` with mixed content off),
 * so non-loopback `ws://` relays fail silently there.
 */

/** The page protocol governing mixed-content rules (injectable for tests). */
function pageProtocol(): string {
  return typeof window !== "undefined" ? window.location.protocol : "";
}

/** True when this runtime can open a WebSocket to `url`. */
export function relayUsableHere(url: string, protocol: string = pageProtocol()): boolean {
  if (/^wss:\/\//i.test(url)) return true;
  if (!/^ws:\/\//i.test(url)) return false;
  // ws:// is fine from insecure pages; loopback is exempt from mixed-content blocking.
  if (protocol === "") return true; // SSR/tests: nothing to judge
  if (protocol === "http:") return true;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Why NONE of `relays` are usable here, or null — so join flows fail loudly. */
export function unusableRelaysReason(relays: string[], protocol: string = pageProtocol()): string | null {
  if (relays.length === 0) return "This community lists no relays.";
  if (relays.some((url) => relayUsableHere(url, protocol))) return null;
  const sample = relays[0];
  return (
    `None of this community's relays are reachable from this app: insecure ` +
    `relays (like ${sample}) are blocked on this platform. Ask the community ` +
    `owner to host it on a wss:// relay.`
  );
}

/** The subset of `relays` that are NOT usable here (for mint-time warnings). */
export function unusableRelaysHere(relays: string[], protocol: string = pageProtocol()): string[] {
  return relays.filter((url) => !relayUsableHere(url, protocol));
}

/**
 * Relays for a NEW community: the `wss://` subset, since `ws://` locks out every
 * APK/https member (#47). Falls back to the full list when it has no `wss://`.
 */
export function preferPortableRelays(relays: string[]): string[] {
  const wss = relays.filter((url) => /^wss:\/\//i.test(url));
  return wss.length > 0 ? wss : relays;
}

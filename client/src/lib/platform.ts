/**
 * Platform (build-time pinned) configuration for internal infrastructure.
 *
 * - `VITE_PLATFORM_RELAYS` — comma-separated relay websocket URLs. These are
 *   always part of the server list and cannot be removed by the user.
 * - `VITE_APP_RELAYS` — comma-separated default app relays used for
 *   non-NIP-29 traffic (profiles, lists). User-overridable in Settings.
 * - `VITE_APP_NAME` — display name of the deployment.
 */

/** Normalize a relay URL: require ws/wss scheme, strip trailing slash. */
export function normalizeRelayUrl(url: string): string | undefined {
  let value = url.trim();
  if (!value) return undefined;
  if (!/^wss?:\/\//i.test(value)) {
    // Bare hostnames are allowed for convenience; assume wss except localhost/IPs.
    const secure = !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
    value = `${secure ? "wss" : "ws"}://${value}`;
  }
  try {
    const u = new URL(value);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return undefined;
    return u.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** Convert a relay websocket URL to its HTTP(S) origin (for NIP-29 livekit endpoints, NIP-11, etc). */
export function relayToHttpUrl(relayUrl: string): string {
  return relayUrl
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/$/, "");
}

/** Relay URL → path segment for routes (`/s/:server`). */
export function relayToRouteParam(relayUrl: string): string {
  return encodeURIComponent(relayUrl.replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === "ws://" ? "ws:" : "")));
}

/** Path segment → relay URL. `relay.internal` ⇒ wss, `ws:host` ⇒ ws. */
export function routeParamToRelay(param: string): string | undefined {
  const decoded = decodeURIComponent(param);
  if (decoded.startsWith("ws:")) {
    return normalizeRelayUrl(`ws://${decoded.slice(3)}`);
  }
  return normalizeRelayUrl(decoded);
}

export const APP_NAME: string = import.meta.env.VITE_APP_NAME || "Armada";

/** Pinned platform relays. Always present; not user-removable. */
export const PLATFORM_RELAYS: string[] = (import.meta.env.VITE_PLATFORM_RELAYS || "ws://localhost:5577")
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/**
 * Default app relays (Ditto's "app relays" concept): general-purpose relays
 * used for non-NIP-29 events — kind 0 profiles, kind 10009 group lists, and
 * any other plain Nostr traffic. Group-scoped events never go here; they are
 * published directly to their host server via `nostr.relay(url)`.
 *
 * These seed `AppConfig.appRelays`, which the user can edit in Settings.
 */
export const APP_RELAYS: string[] = (import.meta.env.VITE_APP_RELAYS || "wss://relay.ditto.pub,wss://relay.dreamith.to")
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/**
 * Default search relays (Ditto's hardcoded `DITTO_RELAYS` concept, made
 * user-editable here). NIP-50 search queries (`search` filters) route here
 * instead of fanning out to every server. Seeds `AppConfig.searchRelays`.
 */
export const SEARCH_RELAYS: string[] = (import.meta.env.VITE_SEARCH_RELAYS || "wss://relay.ditto.pub,wss://relay.dreamith.to")
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/**
 * Default Concord voice servers: blind LiveKit token brokers (https origins)
 * a new Concord community is seeded with. A member joins voice through the
 * first that answers the capability probe. The broker authorizes by
 * channel-key-possession proof (not membership), so it learns nothing about the
 * community; armada's own relay hosts the broker endpoint, so the platform
 * relays' HTTP origins are the natural default. Operators can override with
 * `VITE_CONCORD_VOICE_SERVERS` (comma-separated https origins) or set it empty
 * to disable Concord voice.
 */
export const CONCORD_VOICE_SERVERS: string[] = (
  import.meta.env.VITE_CONCORD_VOICE_SERVERS ??
  PLATFORM_RELAYS.map((url) => relayToHttpUrl(url)).join(",")
)
  .split(",")
  .map((s: string) => s.trim())
  .filter((s: string) => Boolean(s));

/**
 * Parse a build-time boolean env var. Vite env vars are always strings (or
 * undefined when unset), so we treat "true"/"1" as true, "false"/"0" as false,
 * and fall back to `dflt` when unset/unrecognised.
 */
function envBool(value: string | undefined, dflt: boolean): boolean {
  if (value === undefined || value === "") return dflt;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return dflt;
}

/**
 * Default mic audio-processing toggles for voice calls. These seed the
 * per-user voice preferences (`getAudioProcessing` in `voiceDevices.ts`) the
 * first time a user opens the in-call audio settings; the user can override
 * each toggle afterwards. Operators set the platform defaults at build time.
 *
 * All three default to `true`, matching LiveKit/browser defaults — good
 * general-purpose noise/echo handling. Operators targeting e.g. music or
 * push-to-talk setups may want to disable some via these env vars.
 */
export const DEFAULT_NOISE_SUPPRESSION: boolean = envBool(
  import.meta.env.VITE_DEFAULT_NOISE_SUPPRESSION,
  true,
);
export const DEFAULT_ECHO_CANCELLATION: boolean = envBool(
  import.meta.env.VITE_DEFAULT_ECHO_CANCELLATION,
  true,
);
export const DEFAULT_AUTO_GAIN_CONTROL: boolean = envBool(
  import.meta.env.VITE_DEFAULT_AUTO_GAIN_CONTROL,
  true,
);

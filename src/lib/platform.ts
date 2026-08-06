/**
 * Platform (build-time pinned) configuration for internal infrastructure.
 *
 * - `VITE_APP_RELAYS` — comma-separated default app relays used for
 *   non-NIP-29 traffic (profiles, lists). User-overridable in Settings.
 * - `VITE_APP_NAME` — display name of the deployment.
 */

import { nip19 } from "nostr-tools";

/** Normalize a relay URL: require ws/wss scheme, strip trailing slash. */
export function normalizeRelayUrl(url: string): string | undefined {
  let value = url.trim();
  if (!value) return undefined;
  // A fully-qualified non-WebSocket URL is invalid, not a bare hostname. If
  // it were prefixed below, `https://relay.example` would become the valid but
  // nonsensical host `wss://https//relay.example`.
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^wss?:\/\//i.test(value)) {
    return undefined;
  }
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

/**
 * Whether the client is running on iOS / iPadOS.
 *
 * iPadOS 13+ reports a desktop-Safari user agent, so a Mac-like UA with more
 * than one touch point is treated as iOS too. Matters for Web Push: iOS only
 * exposes the Push API (and even the Notification API) to a Home-Screen PWA,
 * never to a Safari tab, and every iOS browser is WKWebView underneath — so the
 * usual "use Chrome/Firefox" fallback advice is wrong there.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** Whether the client is running as an installed, standalone PWA. */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const displayMode = window.matchMedia?.(
    "(display-mode: standalone), (display-mode: fullscreen)",
  ).matches;
  const iosStandalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(displayMode) || iosStandalone;
}

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
 * Public NIP-65 indexes used only for a bounded kind-10002 lookup at login.
 * They are not added to the general pool, subscribed to, or used for normal
 * account traffic. Operators may replace the set or leave it empty; the app
 * relays and a user-entered bootstrap hint are still queried.
 */
export const RELAY_LIST_DISCOVERY_RELAYS: string[] = (
  import.meta.env.VITE_NIP65_DISCOVERY_RELAYS
  ?? "wss://purplepag.es,wss://user.kindpag.es,wss://relay.nos.social"
)
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
 * The NIP-34 repository directory: an index of kind-30617 announcements, read
 * to search for a repository by name and as a fallback when an address carries
 * no usable hint. Discovery only — it is never subscribed to for ongoing
 * activity and never persisted as a repository's activity relay. Operators can
 * point `VITE_GIT_DISCOVERY_RELAY` at their own index, or set it empty to
 * disable directory search (pasted addresses still resolve from their hints).
 */
export const GIT_ANNOUNCEMENT_DISCOVERY_RELAY: string =
  normalizeRelayUrl(import.meta.env.VITE_GIT_DISCOVERY_RELAY ?? "wss://index.ngit.dev") ?? "";

/** Whether a relay is the discovery index, compared as normalized URLs rather than by substring. */
export function isGitAnnouncementDiscoveryRelay(url: string): boolean {
  return GIT_ANNOUNCEMENT_DISCOVERY_RELAY !== "" && normalizeRelayUrl(url) === GIT_ANNOUNCEMENT_DISCOVERY_RELAY;
}

/**
 * Default Concord AV brokers (CORD-07 §2): blind LiveKit token brokers (https
 * origins) used to START a call in an empty voice channel — once anyone is in
 * a call, their presence-announced broker is the rendezvous point (§5). The
 * broker authorizes by channel-key-possession proof, not membership, so it
 * learns nothing about the community.
 *
 * Unset ⇒ the public Armada instance. Operators can override with
 * `VITE_CONCORD_AV_SERVERS` (comma-separated https origins) or set it empty to
 * disable Concord voice.
 */
const DEFAULT_PUBLIC_AV_SERVER = "https://armada.buzz";
export const CONCORD_AV_SERVERS: string[] = (
  import.meta.env.VITE_CONCORD_AV_SERVERS ?? DEFAULT_PUBLIC_AV_SERVER
)
  .split(",")
  .map((s: string) => s.trim())
  .filter((s: string) => Boolean(s));

/**
 * Default LiveKit-capable NIP-29 relay(s) to host **DM** voice rooms, when none
 * of the user's own DM relays speak the NIP-29 LiveKit extension.
 *
 * DM voice runs over a relay's NIP-29 LiveKit token endpoint, which none of the
 * default app relays host — so this defaults to the public Armada instance
 * (`wss://armada.buzz`) so 1:1 calls work out of the box. Operators can
 * override with `VITE_DM_VOICE_RELAYS` (comma-separated ws/wss URLs) or set it
 * empty to disable the fallback.
 */
const DEFAULT_PUBLIC_DM_VOICE_RELAY = "wss://armada.buzz";
export const DM_VOICE_RELAYS: string[] = (
  import.meta.env.VITE_DM_VOICE_RELAYS ?? DEFAULT_PUBLIC_DM_VOICE_RELAY
)
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/**
 * Default DM relay(s): the fallback direct-message relays used when a user has
 * not configured their own (no kind-10050 inbox, `useOwnDmRelays` off). Added
 * to the app relays in `effectiveDmRelays` so gift-wrapped DMs (NIP-17, kind
 * 1059) have a dependable home that the push/native watch sets can rely on —
 * the public default is a gift-wrap-only relay, so legacy NIP-04 (kind 4) DMs
 * continue to use the general app relays alongside it.
 *
 * Defaults to Armada's public gift-wrap relay for every build (like
 * `DM_VOICE_RELAYS` / `CONCORD_AV_SERVERS`); operators can override with
 * `VITE_DM_RELAYS` (comma-separated ws/wss) or set it empty to disable.
 */
const DEFAULT_PUBLIC_DM_RELAY = "wss://relay.armada.buzz";
export const DM_RELAYS: string[] = (import.meta.env.VITE_DM_RELAYS ?? DEFAULT_PUBLIC_DM_RELAY)
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

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

/**
 * Default for the RNNoise ML noise-cancellation track processor (the
 * Discord-style background-noise remover, BSD-licensed, the same engine Jitsi
 * ships). Unlike the three constraints above — which are simple browser
 * MediaTrackConstraints — this runs an AudioWorklet + WASM model over the
 * captured mic and publishes the cleaned track. On by default; operators can
 * disable it at build time (e.g. for low-power clients) and users can toggle it
 * per-device in voice settings.
 */
export const DEFAULT_RNNOISE: boolean = envBool(import.meta.env.VITE_DEFAULT_RNNOISE, true);

/**
 * Cross-origin sandbox domain for in-chat apps (webxdc / YouTube watchalong).
 *
 * Untrusted app content (an arbitrary `.xdc` archive, or a third-party YouTube
 * iframe) runs inside an `<iframe>` on a *distinct* origin — a per-app
 * HMAC-derived subdomain of this domain — so it is fully origin-isolated from
 * the Armada client (no access to our localStorage/IndexedDB/cookies). The
 * subdomain hosts a tiny Service Worker (the "iframe.diy" loader) that proxies
 * every `fetch` back to the parent over `postMessage`; the parent serves the
 * app's files from memory (see `SandboxFrame`). The public `iframe.diy` service
 * provides this; operators may self-host an equivalent and override here.
 */
export const SANDBOX_DOMAIN: string = import.meta.env.VITE_SANDBOX_DOMAIN || "iframe.diy";

/**
 * Generic link-preview (OEmbed) proxy, for URLs whose host has no native OEmbed
 * endpoint of its own.
 *
 * Unfurling runs in the browser, so whatever this points at sees every link URL
 * a user's client renders a preview for. It defaults to the public `ditto.pub`
 * proxy; operators who would rather not route their users' link traffic through
 * a third party can point it at their own unfurler, or set it empty to turn
 * generic previews off entirely. Empty does not disable previews for
 * YouTube/Spotify/Reddit — those are fetched from the provider's own OEmbed
 * endpoint, which the browser contacts directly either way.
 *
 * The value is a template: a literal `{url}` is replaced with the
 * percent-encoded target URL. Without a `{url}` placeholder the encoded URL is
 * appended instead, so both `https://example.com/api/link-preview/` and
 * `https://example.com/oembed?url=` work as written.
 */
export const LINK_PREVIEW_ENDPOINT: string = (
  import.meta.env.VITE_LINK_PREVIEW_ENDPOINT ?? "https://ditto.pub/api/link-preview/{url}"
).trim();

/** Build the proxy request URL for a link preview, or null if no proxy is configured. */
export function linkPreviewUrl(url: string): string | null {
  if (!LINK_PREVIEW_ENDPOINT) return null;
  const encoded = encodeURIComponent(url);
  return LINK_PREVIEW_ENDPOINT.includes("{url}")
    ? LINK_PREVIEW_ENDPOINT.replaceAll("{url}", encoded)
    : `${LINK_PREVIEW_ENDPOINT}${encoded}`;
}

/** Normalize the configured portal origin, or "" for absent/unusable. */
function parseBridgePortalUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    // Refuse anything that isn't a web origin: this string ends up in an href,
    // and a `javascript:` value from a bad build arg would be script injection.
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/**
 * Discord bridge portal (the `armada-discord-bridge` companion service), named
 * at build time.
 *
 * OFF by default. The portal is deployment infrastructure, not part of the
 * protocol: it is a hosted web app that holds a Discord bot token, a Discord
 * OAuth application, and per-bridge key material. A build that doesn't have one
 * to point at must not advertise Discord features at all, so every Discord
 * affordance in the UI is gated on this being set. Forks, the Android APK, the
 * desktop app, and `npm run dev` all render nothing.
 *
 * Nothing is dialed on boot and no Armada data is sent here — this is only the
 * origin of links the user clicks, which is why a compiled-in value is fine
 * where a relay pin would not be (see "How the client reaches backends").
 * Importing happens entirely on the portal: the user signs in with Discord
 * there, and the resulting community is signed with *their own* Nostr key, then
 * joined back here with the invite link the portal hands them.
 */
export const BRIDGE_PORTAL_URL: string = parseBridgePortalUrl(
  import.meta.env.VITE_BRIDGE_PORTAL_URL ?? "",
);

/**
 * Absolute URL into the bridge portal, or `null` when this build has no portal
 * configured — callers render nothing on `null`.
 *
 * - `/import` opens the "import a Discord server" wizard directly.
 * - `/` is the portal dashboard, where existing bridges are managed.
 */
export function bridgePortalUrl(path: "/" | "/import" = "/"): string | null {
  if (!BRIDGE_PORTAL_URL) return null;
  return path === "/" ? BRIDGE_PORTAL_URL : `${BRIDGE_PORTAL_URL}${path}`;
}

/**
 * Privacy-friendly analytics (Plausible), configured at build time.
 *
 * OFF by default: analytics is deployment infrastructure, not something baked
 * into every build. `VITE_PLAUSIBLE_DOMAIN` is set only by a *hosted*
 * deployment (the operator names the site they
 * registered in Plausible, e.g. `armada.buzz`). Every other build — the Android
 * APK, the Electron desktop app, and local `npm run dev` — leaves it empty, so
 * `PlausibleProvider` never loads the tracker and no telemetry is sent. This is
 * why it lives here (build-time infra) rather than in the user-synced
 * `AppConfig`: it must not be togglable, editable, or synced across devices.
 *
 * Plausible is cookieless and does not track individual users or collect
 * personal data (see the Privacy Policy). `VITE_PLAUSIBLE_ENDPOINT` optionally
 * points at a self-hosted instance or a same-origin proxy
 * (https://plausible.io/docs/proxy/introduction); unset uses Plausible Cloud's
 * default API endpoint.
 */
export const PLAUSIBLE_DOMAIN: string = (import.meta.env.VITE_PLAUSIBLE_DOMAIN ?? "").trim();
export const PLAUSIBLE_ENDPOINT: string = (import.meta.env.VITE_PLAUSIBLE_ENDPOINT ?? "").trim();

/**
 * nostr-push web-push server (the NIP-PUSH gateway that replaced the removed
 * armada-relay push endpoint).
 *
 * - `VITE_NOSTR_PUSH_PUBKEY` — the push server's Nostr identity (npub or hex).
 *   Clients address it by `#p`-tagging this pubkey on kind-25742 RPC events.
 * - `VITE_NOSTR_PUSH_RELAYS` — the rendezvous relays the RPC events are
 *   published to / listened for the reply on (comma-separated ws/wss). The
 *   server must read these relays too.
 *
 * Both empty ⇒ nostr-push is not configured and the client has no web-push path
 * at all (the Android build still has its native background service). Being
 * content-blind, the server can serve any deployment, so it is named explicitly
 * rather than derived from a relay the deployment happens to own.
 */
function decodePushPubkey(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (value.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === "npub") return decoded.data;
    } catch {
      // fall through
    }
  }
  return undefined;
}

export const NOSTR_PUSH_PUBKEY: string | undefined = decodePushPubkey(
  import.meta.env.VITE_NOSTR_PUSH_PUBKEY ?? "",
);

export const NOSTR_PUSH_RELAYS: string[] = (import.meta.env.VITE_NOSTR_PUSH_RELAYS ?? "")
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/** True when the nostr-push gateway is configured for this build. */
export function nostrPushConfigured(): boolean {
  return Boolean(NOSTR_PUSH_PUBKEY) && NOSTR_PUSH_RELAYS.length > 0;
}

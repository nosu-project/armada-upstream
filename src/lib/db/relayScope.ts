/**
 * Which tenant an incoming relay event belongs in: `main`, or the serving
 * relay's own tenant.
 *
 * NIP-29 can't share `main`: a group is the PAIR (relay, id), and scoping by
 * signing key fails because some relays (zooid) share an identity, making
 * addressable 39000s from two servers overwrite each other. Only the serving
 * relay distinguishes them, so it's in the TENANT ID.
 *
 * Relay-scoped: anything with an `h` tag (derived, so future group kinds scope
 * automatically) and {@link RELAY_STATE_KINDS}. Everything else (profiles,
 * kind-10009, labels, git, Concord outers, NIP-04) is global and stays in
 * `main` — scope by what the data IS, not which socket delivered it.
 *
 * Relay-relative events with an unknown source relay are DROPPED, never
 * guessed; NIP-29 reads all go through `nostr.relay(url)`, so nothing is lost.
 */
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Relay-signed state scoped to the relay itself: 39000 metadata, 39001 admins,
 * 39002 members, 39003 roles, 39004 live participants, 39005 pins, 13534 NIP-43 roster.
 */
export const RELAY_STATE_KINDS = [13534, 39000, 39001, 39002, 39003, 39004, 39005];

const RELAY_STATE = new Set(RELAY_STATE_KINDS);

/** Whether this event's identity depends on the relay that served it. */
export function isRelayScoped(event: { kind: number; tags: string[][] }): boolean {
  if (RELAY_STATE.has(event.kind)) return true;
  return event.tags.some((tag) => tag[0] === "h" && typeof tag[1] === "string" && tag[1] !== "");
}

/**
 * The tenant holding one relay's NIP-29 data (normalized URL, so slashes/case
 * can't fork a channel's history), or `undefined` for an unusable URL.
 */
export function nip29Tenant(relayUrl: string): string | undefined {
  const normalized = normalizeRelayUrl(relayUrl);
  return normalized ? `nip29:${normalized}` : undefined;
}

/** The tenant an event belongs in, or `undefined` to not store it. */
export function tenantForEvent(
  event: NostrRumor | { kind: number; tags: string[][] },
  relayUrl: string | undefined,
  mainTenant: string,
): string | undefined {
  if (!isRelayScoped(event)) return mainTenant;
  return relayUrl ? nip29Tenant(relayUrl) : undefined;
}

import { nip19 } from "nostr-tools";

import { isNostrId } from "@/lib/nostrId";
import { normalizeRelayUrl } from "@/lib/platform";
import { isLocalNetworkUrl } from "@/lib/sanitizeUrl";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Where Discover's curated author list comes from, and which relays it reads.
 *
 * Discover never shows the public firehose by default: every feed is gated on
 * an author allow-list, seeded by ONE curation source — a list event whose `p`
 * tags are the curated authors — plus, when logged in, the viewer and their
 * own follows. The source is a build-time default ({@link BUILD_DISCOVER_CURATION})
 * that a user can override per client (`AppConfig.discoverCuration`), and the
 * relays are the app relays unless the user names their own
 * (`AppConfig.discoverRelays`).
 *
 * A source is written the way a user would paste it:
 *
 * - an `naddr` — any addressable list carrying `p` tags (a kind-39089 follow
 *   pack, a kind-30000 follow set, …);
 * - an `npub` / `nprofile` / 64-char hex pubkey — that person's follow list
 *   (kind 3), i.e. "show me what this person follows";
 * - `none` — no curated list at all: only you and the people you follow.
 */

/**
 * The Armada team follow pack (kind 39089 by Soapbox). The default curation
 * source when the build sets nothing else.
 */
export const ARMADA_FOLLOW_PACK =
  "naddr1qvzqqqyckypzpyexz3t34l966ngh5xg7u2q788hthdqmj0av3lv8s2tz9t43zt6dqqxxkdrsx4mnqm3jxfeh2ess5pyrw";

/** The spelling of "no curated list". */
export const DISCOVER_CURATION_NONE = "none";

/**
 * This build's curation source. `VITE_DISCOVER_CURATION` accepts anything
 * {@link parseDiscoverCuration} does; set it empty for no curated list.
 */
export const BUILD_DISCOVER_CURATION: string =
  (import.meta.env.VITE_DISCOVER_CURATION ?? ARMADA_FOLLOW_PACK).trim() || DISCOVER_CURATION_NONE;

/** A resolved curation source. */
export type DiscoverCuration =
  | {
      type: "list";
      kind: number;
      pubkey: string;
      identifier: string;
      /** Relay hints carried by the naddr, read alongside the Discover relays. */
      relays: string[];
    }
  | { type: "follows"; pubkey: string; relays: string[] }
  | { type: "none" };

export type ParsedCuration =
  | { ok: true; curation: DiscoverCuration }
  | { ok: false; error: string };

const NONE: DiscoverCuration = { type: "none" };

/**
 * A pasted source's relay hints, narrowed the way every sender-named hint is
 * (`publicRelayHints`): `wss:` on a public host. The source syncs across
 * devices, so a LAN hint would be dialed from each of them on every read.
 */
function hints(relays: string[] | undefined): string[] {
  return (relays ?? [])
    .map(normalizeRelayUrl)
    .filter((url): url is string => !!url && url.startsWith("wss://") && !isLocalNetworkUrl(url));
}

/**
 * Parse a curation source as typed or stored. Accepts `none`, an `naddr` of an
 * addressable kind, or an `npub` / `nprofile` / hex pubkey (a `nostr:` prefix
 * is tolerated). Anything else is an error, worded for the settings field.
 */
export function parseDiscoverCuration(input: string): ParsedCuration {
  const value = input.trim().replace(/^nostr:/i, "");
  if (!value) return { ok: false, error: "Enter an naddr, npub, or hex pubkey." };
  if (value.toLowerCase() === DISCOVER_CURATION_NONE) return { ok: true, curation: NONE };
  if (isNostrId(value.toLowerCase())) {
    return { ok: true, curation: { type: "follows", pubkey: value.toLowerCase(), relays: [] } };
  }
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(value);
  } catch {
    return { ok: false, error: "Not a valid naddr, npub, or hex pubkey." };
  }
  switch (decoded.type) {
    case "naddr": {
      const { kind, pubkey, identifier, relays } = decoded.data;
      if (kind < 30000 || kind >= 40000 || !isNostrId(pubkey)) {
        return { ok: false, error: "That naddr doesn't point to an addressable list." };
      }
      return { ok: true, curation: { type: "list", kind, pubkey, identifier, relays: hints(relays) } };
    }
    case "npub":
      return { ok: true, curation: { type: "follows", pubkey: decoded.data, relays: [] } };
    case "nprofile":
      return {
        ok: true,
        curation: { type: "follows", pubkey: decoded.data.pubkey, relays: hints(decoded.data.relays) },
      };
    default:
      return { ok: false, error: "Use an naddr (a list), an npub, or a hex pubkey." };
  }
}

/**
 * The curation source in effect: the user's override when one is set, the
 * build default otherwise. An override that no longer parses (a corrupted or
 * hand-edited setting) resolves to NO curated list rather than back to the
 * build default — someone who replaced the default list shouldn't get it back
 * silently.
 */
export function resolveDiscoverCuration(
  override: string,
  buildDefault: string = BUILD_DISCOVER_CURATION,
): DiscoverCuration {
  if (override.trim()) {
    const parsed = parseDiscoverCuration(override);
    return parsed.ok ? parsed.curation : NONE;
  }
  const parsed = parseDiscoverCuration(buildDefault);
  return parsed.ok ? parsed.curation : NONE;
}

/**
 * The relays Discover reads: the user's own Discover relays when they set
 * any, otherwise the app relays. Normalized and de-duplicated.
 */
export function resolveDiscoverRelays(override: string[], appRelays: string[]): string[] {
  const normalize = (urls: string[]) => [
    ...new Set(urls.map(normalizeRelayUrl).filter((url): url is string => !!url)),
  ];
  const own = normalize(override);
  return own.length > 0 ? own : normalize(appRelays);
}

/** A stable identity for a curation source — query keys and seed keys. */
export function curationKey(curation: DiscoverCuration): string {
  switch (curation.type) {
    case "list":
      return `${curation.kind}:${curation.pubkey}:${curation.identifier}`;
    case "follows":
      return `3:${curation.pubkey}`;
    case "none":
      return DISCOVER_CURATION_NONE;
  }
}

/** The filter that reads a curation source's list event, or `null` for none. */
export function curationFilter(curation: DiscoverCuration): NostrFilter | null {
  switch (curation.type) {
    case "list":
      return { kinds: [curation.kind], authors: [curation.pubkey], "#d": [curation.identifier], limit: 1 };
    case "follows":
      return { kinds: [3], authors: [curation.pubkey], limit: 1 };
    case "none":
      return null;
  }
}

/** Whether an event is (a version of) the curation source's list event. */
export function isCurationEvent(curation: DiscoverCuration, event: NostrRumor): boolean {
  switch (curation.type) {
    case "list":
      return (
        event.kind === curation.kind
        && event.pubkey === curation.pubkey
        && (event.tags.find(([n]) => n === "d")?.[1] ?? "") === curation.identifier
      );
    case "follows":
      return event.kind === 3 && event.pubkey === curation.pubkey;
    case "none":
      return false;
  }
}

/**
 * What kind of list a source reads, as a noun phrase for UI copy ("a follow
 * pack"). The list's owner is named separately, since it needs a profile read.
 */
export function describeCurationList(curation: DiscoverCuration): string {
  switch (curation.type) {
    case "list":
      if (curation.kind === 39089) return "a follow pack";
      if (curation.kind === 30000) return "a follow set";
      return `a kind-${curation.kind} list`;
    case "follows":
      return "the follow list";
    case "none":
      return "no curated list";
  }
}

/** Valid (hex) member pubkeys from a list event's `p` tags. */
export function curatedPubkeys(event: NostrRumor | null | undefined): string[] {
  if (!event) return [];
  return event.tags
    .filter(([name]) => name === "p")
    .map(([, pk]) => pk)
    .filter(isNostrId);
}

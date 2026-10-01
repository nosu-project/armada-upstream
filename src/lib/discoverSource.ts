import { nip19 } from "nostr-tools";

import { config } from "@/lib/env";
import { isNostrId } from "@/lib/nostrId";
import { normalizeRelayUrl } from "@/lib/platform";
import { isLocalNetworkUrl } from "@/lib/sanitizeUrl";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Discover's curation source and relays. Feeds are gated on an author
 * allow-list: ONE curation source's `p` tags plus the viewer and their follows.
 * The build default ({@link BUILD_DISCOVER_CURATION}) is user-overridable
 * (`AppConfig.discoverCuration`). A source is an `naddr` (any `p`-tagged list),
 * an `npub`/`nprofile`/hex pubkey (their kind-3 follows), or `none`.
 */

/** The Armada team follow pack (kind 39089 by Soapbox); the default source. */
export const ARMADA_FOLLOW_PACK =
  "naddr1qvzqqqyckypzpyexz3t34l966ngh5xg7u2q788hthdqmj0av3lv8s2tz9t43zt6dqqxxkdrsx4mnqm3jxfeh2ess5pyrw";

export const DISCOVER_CURATION_NONE = "none";

/** This build's source via `DISCOVER_CURATION` (empty = none). */
export const BUILD_DISCOVER_CURATION: string =
  (config("DISCOVER_CURATION") ?? ARMADA_FOLLOW_PACK).trim() || DISCOVER_CURATION_NONE;

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
 * Relay hints narrowed to public `wss:` (`publicRelayHints`): the source syncs
 * across devices, so LAN hints would be dialed from each.
 */
function hints(relays: string[] | undefined): string[] {
  return (relays ?? [])
    .map(normalizeRelayUrl)
    .filter((url): url is string => !!url && url.startsWith("wss://") && !isLocalNetworkUrl(url));
}

/** Parse a curation source (`none`, naddr, npub/nprofile/hex, optional `nostr:`); errors are UI-worded. */
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
 * The source in effect: override, else build default. An unparseable override
 * resolves to none, never silently back to the default.
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

/** Discover relays: app relays then the user's NIP-65 relays, normalized and deduped. */
export function resolveDiscoverRelays(appRelays: string[], ownRelays: string[] = []): string[] {
  return [
    ...new Set([...appRelays, ...ownRelays].map(normalizeRelayUrl).filter((url): url is string => !!url)),
  ];
}

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

export function curatedPubkeys(event: NostrRumor | null | undefined): string[] {
  if (!event) return [];
  return event.tags
    .filter(([name]) => name === "p")
    .map(([, pk]) => pk)
    .filter(isNostrId);
}

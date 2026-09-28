/**
 * Ditto off-ramp URLs (ditto.pub renders the full social view). Ditto's root
 * resolver accepts any NIP-19 id; `/t/<tag>` for hashtags. Malformed input
 * (untrusted hex) returns `undefined` so callers skip the link.
 */
import { tryNaddrEncode, tryNeventEncode, tryNpubEncode } from "@/lib/safeNip19";

import type { NostrRumor } from "@/lib/nostrRumor";

const DITTO_ORIGIN = "https://ditto.pub";

/** Off-ramp for an event: `naddr` for addressable (stable across edits), else `nevent` with author hint. */
export function dittoEventUrl(event: NostrRumor): string | undefined {
  if (event.kind >= 30000 && event.kind < 40000) {
    const identifier = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const naddr = tryNaddrEncode({
      kind: event.kind,
      pubkey: event.pubkey,
      identifier,
    });
    return naddr ? `${DITTO_ORIGIN}/${naddr}` : undefined;
  }

  const nevent = tryNeventEncode({ id: event.id, author: event.pubkey });
  return nevent ? `${DITTO_ORIGIN}/${nevent}` : undefined;
}

export function dittoProfileUrl(pubkey: string): string | undefined {
  const npub = tryNpubEncode(pubkey);
  return npub ? `${DITTO_ORIGIN}/${npub}` : undefined;
}

export function dittoHashtagUrl(tag: string): string {
  return `${DITTO_ORIGIN}/t/${encodeURIComponent(tag.toLowerCase())}`;
}

/** Off-ramp for an existing bech32 NIP-19 id, for references not expanded inline. */
export function dittoNip19Url(id: string): string {
  return `${DITTO_ORIGIN}/${id}`;
}

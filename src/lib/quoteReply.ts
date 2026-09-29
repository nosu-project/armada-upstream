import { nip19 } from "nostr-tools";

const HEX_ID_REGEX = /^[0-9a-f]{64}$/;
const EVENT_REF_REGEX = /\b(?:note1|nevent1)[023456789acdefghjklmnpqrstuvwxyz]+/g;

/** Event ids referenced by a `note1`/`nevent1` anywhere in the content, bare or inside a URL. */
function referencedEventIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const [ref] of content.matchAll(EVENT_REF_REGEX)) {
    try {
      const decoded = nip19.decode(ref);
      if (decoded.type === "note") ids.add(decoded.data);
      else if (decoded.type === "nevent") ids.add(decoded.data.id);
    } catch {
      // Invalid bech32, skip
    }
  }
  return ids;
}

/**
 * The NIP-C7 `q` naming an inline-reply parent. The composer also `q`-tags every
 * event embedded in the content (NIP-18), so a `q` whose event the content
 * references is a quote, not a parent; an `a`-style coordinate never is one.
 */
export function inlineReplyQuoteId(ev: { content: string; tags: string[][] }): string | undefined {
  let embedded: Set<string> | undefined;
  for (const [name, value] of ev.tags) {
    if (name !== "q" || !HEX_ID_REGEX.test(value)) continue;
    embedded ??= referencedEventIds(ev.content);
    if (!embedded.has(value)) return value;
  }
  return undefined;
}

import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";

/** NIP-51 search-relay list kind. */
export const KIND_SEARCH_RELAYS = 10007;

export interface SearchRelayList {
  relays: string[];
  publicRelays: string[];
  privateRelays: string[];
  privateTags: string[][];
  decryptFailed: boolean;
}
function relayTags(tags: string[][]): string[] {
  const seen = new Set<string>();
  const relays: string[] = [];
  for (const [name, raw] of tags) {
    if (name !== "relay" || !raw) continue;
    const url = normalizeRelayUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    relays.push(url);
  }
  return relays;
}

/** Read public and NIP-44-private `relay` items without changing their visibility. */
export async function readSearchRelayList(
  event: NostrEvent | null | undefined,
  signer: NostrSigner,
): Promise<SearchRelayList> {
  if (!event) {
    return {
      relays: [],
      publicRelays: [],
      privateRelays: [],
      privateTags: [],
      decryptFailed: false,
    };
  }

  const publicRelays = relayTags(event.tags);
  let privateTags: string[][] = [];
  let decryptFailed = false;
  if (event.content) {
    if (!signer.nip44) {
      decryptFailed = true;
    } else {
      try {
        const plaintext = await signer.nip44.decrypt(event.pubkey, event.content);
        const parsed = JSON.parse(plaintext);
        if (!Array.isArray(parsed)) throw new Error("Private list is not an array");
        privateTags = parsed.filter(
          (tag): tag is string[] => Array.isArray(tag) && tag.every((item) => typeof item === "string"),
        );
      } catch {
        decryptFailed = true;
      }
    }
  }

  const privateRelays = decryptFailed ? [] : relayTags(privateTags);
  return {
    relays: [...new Set([...publicRelays, ...privateRelays])],
    publicRelays,
    privateRelays,
    privateTags,
    decryptFailed,
  };
}

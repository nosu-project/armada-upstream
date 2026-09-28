import { useEffect } from "react";

import { tryNpubEncode } from "@/lib/safeNip19";

/**
 * Module-level bus letting any component ask the active composer to insert a NIP-27
 * mention, without threading callbacks through the tree.
 */
type MentionListener = (text: string) => void;

const listeners = new Set<MentionListener>();

export function requestMention(pubkey: string): boolean {
  const npub = tryNpubEncode(pubkey);
  if (!npub) return false;
  const text = `nostr:${npub} `;
  for (const listener of listeners) listener(text);
  return listeners.size > 0;
}

export function useMentionInsertions(insert: (text: string) => void) {
  useEffect(() => {
    listeners.add(insert);
    return () => {
      listeners.delete(insert);
    };
  }, [insert]);
}

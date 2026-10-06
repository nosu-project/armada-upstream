/**
 * Search locally decrypted DM history on both planes (never prompts the signer):
 * NIP-17 rumors are stored decrypted; kind-4 matches only messages whose plaintext is in
 * the session render cache (getRenderedPlaintext). Returns the newest match per peer.
 */
import { useEffect, useMemo, useState } from "react";


import { getRenderedPlaintext } from "@/hooks/dmRenderCache";
import { dmCounterparty } from "@/hooks/useDirectMessages";
import { searchDm17Rumors } from "@/lib/nip17/dm17Store";
import { dmConvKey } from "@/lib/nip17/conversation";
import type { NostrRumor } from "@/lib/nostrRumor";

export interface DmMessageMatch {
  /** Conversation key (see `dmConvKey`) — a bare pubkey for a 1:1. */
  peer: string;
  text: string;
  createdAt: number;
}

/**
 * @param events  fetched kind-4 ciphertext events (from useDMConversations)
 * @param self    the viewer's pubkey (to resolve each kind-4 counterparty)
 */
export function useDmMessageSearch(
  query: string,
  events: NostrRumor[],
  self: string | undefined,
): Map<string, DmMessageMatch> {
  const needle = query.trim().toLowerCase();

  // Keep the last result so the list doesn't flicker between keystrokes.
  const [dm17Matches, setDm17Matches] = useState<Map<string, DmMessageMatch>>(new Map());
  useEffect(() => {
    if (!needle || !self) {
      setDm17Matches(new Map());
      return;
    }
    let cancelled = false;
    // A whole-history read; the next keystroke abandons this one.
    const abort = new AbortController();
    void searchDm17Rumors(self, query, { limit: 500, signal: abort.signal }).then((rumors) => {
      if (cancelled) return;
      const byPeer = new Map<string, DmMessageMatch>();
      for (const r of rumors) {
        const key = dmConvKey(r.peers);
        const cur = byPeer.get(key);
        if (!cur || r.createdAt > cur.createdAt) {
          byPeer.set(key, { peer: key, text: r.content, createdAt: r.createdAt });
        }
      }
      setDm17Matches(byPeer);
    }, () => {});
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [needle, query, self]);

  const kind4Matches = useMemo(() => {
    const byPeer = new Map<string, DmMessageMatch>();
    if (!needle || !self) return byPeer;
    for (const event of events) {
      const text = getRenderedPlaintext(event.id);
      if (text === undefined || !text.toLowerCase().includes(needle)) continue;
      const peer = dmCounterparty(event, self);
      if (!peer) continue;
      const cur = byPeer.get(peer);
      if (!cur || event.created_at > cur.createdAt) {
        byPeer.set(peer, { peer, text, createdAt: event.created_at });
      }
    }
    return byPeer;
  }, [needle, events, self]);

  return useMemo(() => {
    if (!needle) return new Map<string, DmMessageMatch>();
    const merged = new Map<string, DmMessageMatch>(kind4Matches);
    for (const [peer, match] of dm17Matches) {
      const cur = merged.get(peer);
      if (!cur || match.createdAt > cur.createdAt) merged.set(peer, match);
    }
    return merged;
  }, [needle, kind4Matches, dm17Matches]);
}

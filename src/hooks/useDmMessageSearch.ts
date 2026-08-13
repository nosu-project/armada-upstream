/**
 * Search decrypted DM message history — across BOTH planes — for a text query.
 *
 * DMs are end-to-end encrypted, so this only searches what is already
 * decrypted locally (never prompts the signer):
 *
 *   - NIP-17: every rumor is persisted decrypted at rest (dm17Store), so its
 *     full local history is searchable.
 *   - kind-4 (legacy): raw ciphertext lives in the conversation query; a
 *     message is searchable only once its plaintext is in the session render
 *     cache (getRenderedPlaintext) — i.e. threads opened this session and the
 *     decrypted list previews.
 *
 * Results are grouped per conversation partner: the best (newest) matching
 * message per peer, with its plaintext for snippet + highlight, so the
 * conversation list can show which peers have a match without loading threads.
 */
import { useEffect, useMemo, useState } from "react";


import { getRenderedPlaintext } from "@/hooks/dmRenderCache";
import { dmCounterparty } from "@/hooks/useDirectMessages";
import { searchDm17Rumors } from "@/lib/nip17/dm17Store";
import { dmConvKey } from "@/lib/nip17/protocol";
import type { NostrRumor } from "@/lib/nostrRumor";

/** A single conversation's best match for the active query. */
export interface DmMessageMatch {
  /**
   * The conversation key (see `dmConvKey`) — a bare pubkey for a 1:1, which is
   * also what the kind-4 half below produces.
   */
  peer: string;
  /** The matched message's decrypted text (for snippet + highlight). */
  text: string;
  /** The match's timestamp (seconds) — used only to pick the newest. */
  createdAt: number;
}

/**
 * Search locally-decrypted DM history for `query`.
 *
 * @param query   the raw search text (trimmed/normalised internally)
 * @param events  fetched kind-4 ciphertext events (from useDMConversations)
 * @param self    the viewer's pubkey (to resolve each kind-4 counterparty)
 */
export function useDmMessageSearch(
  query: string,
  events: NostrRumor[],
  self: string | undefined,
): Map<string, DmMessageMatch> {
  const needle = query.trim().toLowerCase();

  // NIP-17 matches come from an async IndexedDB scan; keep the last result so
  // the list doesn't flicker between keystrokes.
  const [dm17Matches, setDm17Matches] = useState<Map<string, DmMessageMatch>>(new Map());
  useEffect(() => {
    if (!needle || !self) {
      setDm17Matches(new Map());
      return;
    }
    let cancelled = false;
    void searchDm17Rumors(self, query, { limit: 500 }).then((rumors) => {
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
    });
    return () => {
      cancelled = true;
    };
  }, [needle, query, self]);

  // kind-4 matches are synchronous: scan the fetched ciphertext events for
  // those whose session-decrypted plaintext contains the needle.
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

  // Merge both planes, newest match per peer wins.
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

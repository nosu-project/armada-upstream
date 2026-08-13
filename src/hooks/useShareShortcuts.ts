import { nip19 } from "nostr-tools";
import { useEffect, useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useEventStore } from "@/hooks/useEventStore";
import { usePinnedDms } from "@/hooks/usePinnedDms";
import { getDisplayName } from "@/lib/getDisplayName";
import { chatRoute } from "@/lib/routes";
import { hasShareTarget, ShareTarget, type ShareShortcutItem } from "@/lib/shareTarget";

import type { NostrMetadata } from "@nostrify/nostrify";

/** Direct Share suggestion cap: launchers surface ~4, the sheet a few more. */
const MAX_SHORTCUTS = 8;
/** Publishing is a background nicety; keep it off the boot path. */
const PUBLISH_DELAY_MS = 5000;

/**
 * Publish the user's DM conversations as ranked Direct Share suggestions
 * (Android sharing shortcuts): pinned DMs first, then by recency — the same
 * order the DM list shows. Community/channel suggestions need no publisher
 * here: the notification service pushes a conversation shortcut per notified
 * room, which gives the OS its frequency signal for those organically.
 *
 * Names and avatar URLs come from the kind-0 profiles already in the local
 * event store (no network); the avatar fetch itself happens NATIVE-side
 * (ShareTargetPlugin.fetchIcon), where arbitrary avatar hosts don't hit CORS.
 */
export function useShareShortcuts(): void {
  const { user } = useCurrentUser();
  const { pinned } = usePinnedDms();
  const { conversations } = useDm17Conversations();
  const eventStore = useEventStore();

  // The ranked top peers, as a string so the publish effect keys on CONTENT:
  // the conversations array is a fresh identity every refetch, and republishing
  // identical shortcuts on each 60s poll would hammer the shortcut manager's
  // rate limit for nothing.
  const peersKey = useMemo(() => {
    if (!user) return "";
    const pinnedSet = new Set(pinned);
    // 1:1 conversations only. A share shortcut is a person — one avatar, one
    // name, and a direct-share slot the OS renders itself — so a group has
    // nothing to put in it. (Note to Self is a 1:1 with yourself and stays.)
    const byRecency = conversations.filter((c) => c.peers.length === 1).map((c) => c.peers[0]);
    const pinnedRanked = byRecency.filter((p) => pinnedSet.has(p));
    for (const p of pinned) if (!pinnedRanked.includes(p)) pinnedRanked.push(p);
    const rest = byRecency.filter((p) => !pinnedSet.has(p));
    return [...pinnedRanked, ...rest].slice(0, MAX_SHORTCUTS).join(",");
  }, [user, pinned, conversations]);

  useEffect(() => {
    if (!hasShareTarget() || !peersKey) return;
    const peers = peersKey.split(",");
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const store = await eventStore;
          const events = await store.query([{ kinds: [0], authors: peers }]);
          const latest = new Map<string, { created_at: number; metadata: NostrMetadata }>();
          for (const ev of events) {
            const prev = latest.get(ev.pubkey);
            if (prev && prev.created_at >= ev.created_at) continue;
            try {
              latest.set(ev.pubkey, {
                created_at: ev.created_at,
                metadata: JSON.parse(ev.content) as NostrMetadata,
              });
            } catch {
              // Unparseable kind 0 — fall back to the npub label below.
            }
          }
          const shortcuts: ShareShortcutItem[] = peers.map((peer) => {
            const metadata = latest.get(peer)?.metadata;
            const name = getDisplayName(metadata);
            const label =
              name !== "Anonymous" ? name : `${nip19.npubEncode(peer).slice(0, 12)}…`;
            const iconUrl = metadata?.picture;
            // The id IS the conversation's route — the contract with the
            // service's pushConversationShortcut and with the share flow's
            // EXTRA_SHORTCUT_ID handling. The service spells DM links with
            // the raw hex pubkey, so this must too (chatRoute does).
            return { id: chatRoute({ kind: "dm", peer }), label, ...(iconUrl ? { iconUrl } : {}) };
          });
          if (!cancelled) await ShareTarget.publishShortcuts({ shortcuts });
        } catch {
          // Best-effort: suggestions just don't update this session.
        }
      })();
    }, PUBLISH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [peersKey, eventStore]);
}

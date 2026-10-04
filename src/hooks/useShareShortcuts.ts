import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useEventStore } from "@/hooks/useEventStore";
import { useMediaPolicy } from "@/hooks/useMediaPolicy";
import { getDisplayName } from "@/lib/getDisplayName";
import { mediaSrc } from "@/lib/mediaPolicy";
import { DM_PEER_SEP } from "@/lib/nip17/conversation";
import { chatRoute, parseChatRoute } from "@/lib/routes";
import {
  hasShareTarget,
  maxShareShortcuts,
  ShareTarget,
  type ShareShortcutItem,
} from "@/lib/shareTarget";
import { sentRooms, subscribeSentRooms, warmSentRooms } from "@/lib/shareTargets";

import type { Dm17Conversation } from "@/hooks/useDm17";
import { plainProfilePicture } from "@/lib/profileImeta";
import type { NostrMetadata } from "@nostrify/nostrify";

/** Keep it off the boot path. */
const PUBLISH_DELAY_MS = 5000;

interface Candidate {
  /** The room's route, which is also the shortcut id. */
  id: string;
  /** Unix seconds the viewer last sent here; 0 for never. */
  sentAt: number;
  /** 1:1 DM — name and picture come from the kind-0. */
  peer?: string;
  /** A room name only the sending page knew (see `shareTargets`). */
  label?: string;
  iconUrl?: string;
}

/**
 * Android Direct Share suggestions, ranked by newest OUTGOING message across DMs, Concord and
 * NIP-29. The single writer of the set (the notification service no longer publishes these).
 * Sources: `Dm17Conversation.mineAt` and the local `shareTargets` ledger (newer wins). Avatars are
 * fetched natively (`ShareTargetPlugin.fetchIcon`) to avoid CORS.
 */
export function useShareShortcuts(): void {
  const { user } = useCurrentUser();
  const { conversations } = useDm17Conversations();
  const eventStore = useEventStore();
  const self = user?.pubkey;
  // Hand down the URL the media policy would load, or none.
  const mediaPolicy = useMediaPolicy();
  const mediaPolicyRef = useRef(mediaPolicy);
  mediaPolicyRef.current = mediaPolicy;

  // Read at publish time (a timer), so it sees the current list.
  const conversationsRef = useRef<Dm17Conversation[]>(conversations);
  conversationsRef.current = conversations;

  // Key on content so the 60s poll doesn't spend the shortcut rate limit.
  const dmKey = useMemo(
    () =>
      self
        ? conversations
            .filter((c) => c.peers.length === 1)
            .map((c) => `${c.peers[0]}:${c.mineAt ?? 0}`)
            .join(",")
        : "",
    [self, conversations],
  );

  const publish = useCallback(async () => {
    if (!self) return;
    const byId = new Map<string, Candidate>();
    const ledger = sentRooms(self);
    const sentAtOf = new Map(ledger.map((r) => [r.route, r.entry.sentAt]));

    // 1:1 only: a share shortcut is one person (Note to Self stays).
    for (const c of conversationsRef.current) {
      if (c.peers.length !== 1) continue;
      const peer = c.peers[0];
      const id = chatRoute({ kind: "dm", peer });
      byId.set(id, { id, peer, sentAt: Math.max(c.mineAt ?? 0, sentAtOf.get(id) ?? 0) });
    }

    for (const { route, entry } of ledger) {
      if (byId.has(route)) continue;
      const parsed = parseChatRoute(route);
      if (parsed?.kind === "dm") {
        // A DM sent moments ago, before the query refetched; groups skipped.
        if (!parsed.peer || parsed.peer.includes(DM_PEER_SEP)) continue;
        byId.set(route, { id: route, peer: parsed.peer, sentAt: entry.sentAt });
      } else if (entry.label) {
        // No label → no shortcut.
        byId.set(route, {
          id: route,
          label: entry.label,
          iconUrl: entry.iconUrl,
          sentAt: entry.sentAt,
        });
      }
    }

    const max = await maxShareShortcuts();
    const ranked = [...byId.values()]
      .sort((a, b) => b.sentAt - a.sentAt)
      .slice(0, max);
    if (ranked.length === 0) return;

    const peers = ranked.map((c) => c.peer).filter((p): p is string => !!p);
    const profiles = new Map<string, NostrMetadata>();
    if (peers.length > 0) {
      const store = await eventStore;
      const events = await store.query([{ kinds: [0], authors: peers }]);
      const at = new Map<string, number>();
      for (const ev of events) {
        if ((at.get(ev.pubkey) ?? -1) >= ev.created_at) continue;
        try {
          const metadata = JSON.parse(ev.content) as NostrMetadata;
          profiles.set(ev.pubkey, { ...metadata, picture: plainProfilePicture(ev.tags, metadata) });
          at.set(ev.pubkey, ev.created_at);
        } catch {
          // Unparseable kind 0 — fall back to the npub label below.
        }
      }
    }

    const shortcuts: ShareShortcutItem[] = [];
    for (const c of ranked) {
      if (c.peer) {
        const metadata = profiles.get(c.peer);
        const name = getDisplayName(metadata);
        const label =
          name !== "Anonymous" ? name : `${nip19.npubEncode(c.peer).slice(0, 12)}…`;
        const iconUrl = mediaSrc(metadata?.picture, mediaPolicyRef.current);
        shortcuts.push({ id: c.id, label, ...(iconUrl ? { iconUrl } : {}) });
      } else if (c.label) {
        const iconUrl = mediaSrc(c.iconUrl, mediaPolicyRef.current);
        shortcuts.push({ id: c.id, label: c.label, ...(iconUrl ? { iconUrl } : {}) });
      }
    }
    if (shortcuts.length > 0) await ShareTarget.publishShortcuts({ shortcuts });
  }, [self, eventStore]);

  useEffect(() => {
    if (!hasShareTarget() || !self) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Restarting the timer coalesces bursts into one publish.
    const schedule = () => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void publish().catch(() => {
          // Best-effort: suggestions just don't update this session.
        });
      }, PUBLISH_DELAY_MS);
    };
    const unsubscribe = subscribeSentRooms(schedule);
    // On cold start the ledger is empty, so warming triggers its own publish.
    void warmSentRooms().catch(() => undefined).then(schedule);
    schedule();
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [self, dmKey, publish]);
}

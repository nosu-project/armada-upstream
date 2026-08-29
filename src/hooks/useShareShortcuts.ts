import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useEventStore } from "@/hooks/useEventStore";
import { getDisplayName } from "@/lib/getDisplayName";
import { DM_PEER_SEP } from "@/lib/nip17/protocol";
import { chatRoute, parseChatRoute } from "@/lib/routes";
import {
  hasShareTarget,
  maxShareShortcuts,
  ShareTarget,
  type ShareShortcutItem,
} from "@/lib/shareTarget";
import { sentRooms, subscribeSentRooms, warmSentRooms } from "@/lib/shareTargets";

import type { Dm17Conversation } from "@/hooks/useDm17";
import type { NostrMetadata } from "@nostrify/nostrify";

/** Publishing is a background nicety; keep it off the boot path. */
const PUBLISH_DELAY_MS = 5000;

/** One room in the running, before its name is resolved. */
interface Candidate {
  /** The room's route, which is also the shortcut id. */
  id: string;
  /** Unix seconds the viewer last sent here; 0 for never. */
  sentAt: number;
  /** Set for a 1:1 DM — its name and picture come from the kind-0 profile. */
  peer?: string;
  /** Set for a room whose name only the sending page knew (see `shareTargets`). */
  label?: string;
  iconUrl?: string;
}

/**
 * Publish the user's rooms as ranked Direct Share suggestions (Android sharing
 * shortcuts), newest OUTGOING message first — DMs, Concord channels and NIP-29
 * groups in one list.
 *
 * "Who do I message" is the question a share suggestion answers, and neither
 * signal the app had was that. This hook ranked DM conversations by
 * `latest.createdAt` — the newest message in the thread whoever sent it — so a
 * chatty stranger outranked a daily correspondent; and the notification service
 * pushed a shortcut per INCOMING notification with no rank at all, which at the
 * default rank 0 evicted every ranked suggestion below it. The service no
 * longer publishes share targets (its shortcuts are for the conversation-space
 * notification look, and are ranked below these), so this is now the single
 * writer of the set.
 *
 * Two sources for the same fact, both in unix seconds:
 * `Dm17Conversation.mineAt` — free, since the conversation query already reads
 * the viewer's newest message per conversation — and the local `shareTargets`
 * ledger, which is the only record of an outgoing Concord or NIP-29 send. A DM
 * takes whichever is newer: the ledger is fresher (it is written at send), the
 * query is durable (it survives a reinstall).
 *
 * Names and avatars come from the kind-0 profiles already in the local event
 * store for DMs (no network, and a renamed contact updates without sending
 * anything) and from the ledger for rooms. The avatar FETCH is native-side
 * (`ShareTargetPlugin.fetchIcon`), where arbitrary avatar hosts don't hit CORS.
 */
export function useShareShortcuts(): void {
  const { user } = useCurrentUser();
  const { conversations } = useDm17Conversations();
  const eventStore = useEventStore();
  const self = user?.pubkey;

  // Read inside the publish, which runs on a timer well after this render, so
  // it always sees the current list rather than the one that scheduled it.
  const conversationsRef = useRef<Dm17Conversation[]>(conversations);
  conversationsRef.current = conversations;

  // The DM inputs as a string, so the effect keys on CONTENT: `conversations`
  // is a fresh identity every refetch, and rescheduling a publish on each 60s
  // poll would spend the shortcut manager's rate limit on nothing.
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

    // 1:1 DMs only. A share shortcut is a person — one avatar, one name, and a
    // slot the OS draws itself — so a group DM has nothing to put in it. (Note
    // to Self is a 1:1 with yourself and stays.) Inserted in the query's
    // newest-message order, which the stable sort below preserves among
    // conversations the viewer has never written in.
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
        // A DM sent to moments ago, before the conversation query refetched.
        // Group keys are skipped for the same reason as above.
        if (!parsed.peer || parsed.peer.includes(DM_PEER_SEP)) continue;
        byId.set(route, { id: route, peer: parsed.peer, sentAt: entry.sentAt });
      } else if (entry.label) {
        // No label means no shortcut: a suggestion the OS can only render as
        // the app icon with no name is worse than one fewer suggestion.
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
          profiles.set(ev.pubkey, JSON.parse(ev.content) as NostrMetadata);
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
        const iconUrl = metadata?.picture;
        shortcuts.push({ id: c.id, label, ...(iconUrl ? { iconUrl } : {}) });
      } else if (c.label) {
        shortcuts.push({ id: c.id, label: c.label, ...(c.iconUrl ? { iconUrl: c.iconUrl } : {}) });
      }
    }
    if (shortcuts.length > 0) await ShareTarget.publishShortcuts({ shortcuts });
  }, [self, eventStore]);

  useEffect(() => {
    if (!hasShareTarget() || !self) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Every trigger restarts the timer, so a burst of sends coalesces into one
    // publish rather than one per message.
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
    // The warm is its own trigger: on a cold start the ledger is empty, so the
    // first publish would otherwise rank every room at "never sent".
    void warmSentRooms().catch(() => undefined).then(schedule);
    schedule();
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [self, dmKey, publish]);
}

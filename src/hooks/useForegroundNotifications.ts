import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useNotifLevels, type NotifLevel } from "@/hooks/useNotifLevels";
import { loadPushPrefs } from "@/lib/pushPrefs";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { parseAuthorEvent, seedAuthorCache, type AuthorResult } from "@/hooks/useAuthor";
import {
  foregroundNotifyIntent,
  notificationsApiAvailable,
} from "@/hooks/useForegroundNotificationSettings";
import { isRoomActive } from "@/lib/activeRooms";
import { getDisplayName } from "@/lib/getDisplayName";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { queryDm17Conversations } from "@/lib/nip17/dm17Store";
import {
  loadNotificationSoundSettings,
  playNotificationSound,
} from "@/lib/notificationSounds";
import { normalizeRelayUrl } from "@/lib/platform";
import { chatRoute, parseChatRoute } from "@/lib/routes";
import { tryNpubEncode } from "@/lib/safeNip19";
import {
  installTabAttentionClearHandlers,
  markTabAttention,
} from "@/lib/tabAttention";
import { registerNotifySink } from "@/wire/notify";
import { useWireNip29Groups } from "@/wire/useWireNip29Groups";

/**
 * useForegroundNotifications
 *
 * The client-side notifier that runs while Armada is OPEN (web / desktop; the
 * native APK uses its background service instead). It surfaces the SAME
 * unread/mention signal the badges already compute — sourced from the wire's
 * ingest, which hands it every live event once — as a real OS
 * `new Notification(...)`, a selected in-app sound, and a browser-tab marker.
 *
 * This is complementary to Web Push (closed-tab delivery via the relay
 * gateway): it needs only the Notifications API + permission, so it works in
 * browsers where Web Push is unavailable (Brave with Google push disabled),
 * which otherwise get nothing while the app is open in the background. The
 * in-app sound and tab marker do not require OS notification permission. Cues
 * fire whether the tab is focused or backgrounded, except for the conversation
 * the user is currently looking at in a focused Armada window (see the
 * active-room gate).
 *
 * Gating (all must pass to produce a cue):
 *   - the conversation's resolved notification level (Discord-style
 *     all/mentions/nothing, `useNotifLevels`, cascading channel → community →
 *     global per-type prefs) admits this message: `all` always, `mentions`
 *     only when it @-mentions you (DMs count), `nothing` never;
 *   - the conversation isn't the one currently on screen (`isRoomActive`);
 *   - the user hasn't already read past it (`useReadState`, NIP-29/DM);
 *   - it's newer than this session's start AND newer than the last thing we
 *     notified for that room (so a backfill / re-ingest never re-alerts).
 * The master foreground intent and OS permission gate only the system
 * Notification; the selected in-app sound and inactive-tab marker remain
 * useful without that permission.
 */

/** Whether a candidate is admitted by a resolved notification level. */
function levelAdmits(level: NotifLevel, mention: boolean): boolean {
  if (level === "nothing") return false;
  if (level === "mentions") return mention;
  return true; // "all"
}

export function useForegroundNotifications(): void {
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  useNostr(); // keep within the Nostr provider tree

  const { readState } = useReadState();
  const { channelLevel, concordChannelLevel, dmLevel } = useNotifLevels();
  const { isKnown } = useKnownDmPeers();
  const { data: groupList } = useUserGroupList();

  // groupId → host relay URL (NIP-29 events don't carry their relay). The
  // kind-10009 list covers explicit joins; the wire's per-server directory
  // discovery covers the rest (channels the user never 10009-listed — e.g.
  // Buzz channels an admin added them to).
  const wireGroups = useWireNip29Groups();
  const relayByGroup = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groupList?.groups ?? []) {
      const relay = normalizeRelayUrl(g.relay);
      if (relay && g.id) m.set(g.id, relay);
    }
    for (const g of wireGroups) {
      if (g.id && g.relay && !m.has(g.id)) m.set(g.id, g.relay);
    }
    return m;
  }, [groupList, wireGroups]);

  // Refs so the (stable) sink reads current values without re-registering on
  // every render — a re-register would drop the wire's reference to the sink.
  const ctx = useRef({
    readState,
    channelLevel,
    concordChannelLevel,
    dmLevel,
    isKnown,
    relayByGroup,
    navigate,
    queryClient,
    eventStore,
  });
  ctx.current = {
    readState,
    channelLevel,
    concordChannelLevel,
    dmLevel,
    isKnown,
    relayByGroup,
    navigate,
    queryClient,
    eventStore,
  };

  // Session floor: never notify for anything older than the moment the notifier
  // mounted (a fresh login backfilling weeks of history must stay silent).
  const sessionFloor = useRef(Math.floor(Date.now() / 1000));
  // Per-room high-water mark of what we've already notified, so overlapping
  // transports / re-ingests don't double-alert.
  const lastNotified = useRef(new Map<string, number>());
  const notifiedEvents = useRef(new Set<string>());

  // `useKnownDmPeers` decides on follows ∪ accepted ∪ pinned ∪ `mine`, and only
  // the caller can supply `mine` — "the viewer has written in this thread".
  // The sink has no conversation rows, so it keeps the peer set here, read from
  // the same store `useNostrPush` seals into the worker's DM config. Passing a
  // hardcoded `false` instead made every thread with an unfollowed peer a
  // content-blind "Message request", however long the two had been talking —
  // and on desktop, where this is the ONLY notifier (Electron has no push and
  // no service worker presenting), that is every DM.
  const minePeers = useRef(new Set<string>());
  const mineLoading = useRef(false);

  useEffect(() => {
    if (!user) return;
    if (isNativeRuntime()) return; // native has its own background service

    const removeTabAttentionHandlers = installTabAttentionClearHandlers();

    // Resolve a display name for an author. Tries, in order: the react-query
    // author cache (populated when a profile has been viewed this session), the
    // shared event store's kind-0 (the wire keeps profiles flowing in), and
    // finally a shortened npub — never a bland "Someone", which was the bug.
    const displayNameFor = async (pubkey: string): Promise<string> => {
      if (!pubkey) return "Someone";
      const qc = ctx.current.queryClient;
      const cached = qc.getQueryData<AuthorResult>(["author", pubkey]);
      if (cached?.metadata) return getDisplayName(cached.metadata, pubkey);
      if (cached?.event) return getDisplayName(parseAuthorEvent(cached.event).metadata, pubkey);

      // Fall back to the local event store (no network) — the profile is very
      // often already here even when no component has subscribed to it.
      try {
        const store = await ctx.current.eventStore;
        const [ev] = await store.query([{ kinds: [0], authors: [pubkey], limit: 1 }]);
        if (ev) {
          const parsed = parseAuthorEvent(ev);
          // Seed the author cache so the next lookup is synchronous.
          seedAuthorCache(qc, pubkey, ev);
          if (parsed.metadata) return getDisplayName(parsed.metadata, pubkey);
        }
      } catch {
        // Store unavailable — fall through to the npub.
      }

      const npub = tryNpubEncode(pubkey);
      return npub ? `${npub.slice(0, 12)}…` : "Someone";
    };

    // Reload the peers the viewer has authored a message to. Called once on
    // mount and again whenever a DM arrives from a peer the current sets don't
    // know: the viewer may have replied since (replying is accepting, but the
    // persisted `acceptedDms` is only written from the compose pane), so one
    // message may present generically before the set catches up — which beats
    // an interval poll, and beats deferring the decision past the point where
    // the `off` policy has to stay silent.
    const refreshMinePeers = () => {
      if (mineLoading.current) return;
      mineLoading.current = true;
      void (async () => {
        try {
          const rows = await queryDm17Conversations(user.pubkey);
          minePeers.current = new Set(rows.filter((row) => row.mine).map((row) => row.peer));
        } catch {
          // Store unavailable — follows ∪ accepted ∪ pinned still apply.
        } finally {
          mineLoading.current = false;
        }
      })();
    };
    refreshMinePeers();

    const unregister = registerNotifySink((candidates) => {
      const intentOn = foregroundNotifyIntent();
      const canShowOsNotification = intentOn
        && notificationsApiAvailable()
        && Notification.permission === "granted";
      const soundSettings = loadNotificationSoundSettings();
      let playedSound = false;

      const c = ctx.current;

      for (const cand of candidates) {
        if (cand.createdAt <= sessionFloor.current) continue;
        // Ingest normally removes self-authored events, but keep the final
        // presentation boundary safe when identity hydration races a live
        // event or another candidate source is added.
        if (cand.author && cand.author === user.pubkey) continue;

        // Resolve the fields ingest left for the hook (relay-dependent
        // routing) and the conversation's notification level.
        let roomKey = cand.roomKey;
        let readKey = cand.readKey;
        let path = cand.path;
        let level: NotifLevel;
        // Set when this is a DM from an unknown sender and the request policy is
        // "generic": still cue, but present nothing the sender controls.
        let dmGeneric = false;

        if (cand.plane === "nip29") {
          const relay = cand.groupId ? c.relayByGroup.get(cand.groupId) : undefined;
          if (!relay || !cand.groupId) continue; // not a group we're in
          roomKey = `h:${relay}|${cand.groupId}`;
          readKey = channelReadKey(relay, cand.groupId);
          path = chatRoute({
            kind: "nip29",
            relayUrl: relay,
            groupId: cand.groupId,
            messageId: cand.eventId,
          });
          level = c.channelLevel(relay, cand.groupId);
        } else if (cand.plane === "dm") {
          level = cand.peer ? c.dmLevel(cand.peer) : "all";
          // Unknown sender (not followed / accepted / pinned): a stranger picks
          // the message text, their display name and their avatar. Apply the
          // message-request policy before any of it is surfaced — "off" stays
          // silent, "generic" cues without content, "full" notifies as normal.
          if (cand.peer && !c.isKnown(cand.peer, minePeers.current.has(cand.peer))) {
            // The viewer may have written to them since the set was loaded.
            refreshMinePeers();
            const policy = loadPushPrefs().dmRequests;
            if (policy === "off") continue;
            if (policy !== "full") dmGeneric = true;
          }
        } else {
          if (!path) continue; // couldn't resolve the community route
          // Recover the community id from the route, to resolve the
          // per-channel level. Parsed rather than split on "/": the route may
          // carry a `/m/<id>` focus, and the parser is the same one the app
          // navigates by.
          // (A git-activity candidate carries a `?ticket=` query; parse only
          // the path part.)
          const parsed = parseChatRoute(path.split("?")[0]);
          const communityId = parsed?.kind === "concord2" ? parsed.communityId : "";
          level =
            communityId && cand.channelIdHex
              ? c.concordChannelLevel("c2", communityId, cand.channelIdHex)
              : "all";
        }

        // Notification-level gate (Discord-style all/mentions/nothing).
        if (!levelAdmits(level, cand.mention)) continue;

        // Read-state gate (NIP-29 / DM have a useReadState entry). If the user
        // already read past this message, don't notify.
        if (readKey && (c.readState[readKey] ?? 0) >= cand.createdAt) continue;

        // On-screen suppression: only while the Armada window is focused and
        // the user is actually looking at this room.
        if (isRoomActive(roomKey)) continue;

        // Dedupe against what we've already surfaced for this room.
        const eventKey = cand.eventId ? `${roomKey}:${cand.eventId}` : "";
        if (eventKey && notifiedEvents.current.has(eventKey)) continue;
        const mark = lastNotified.current.get(roomKey) ?? 0;
        // Legacy candidates lack an event id, so retain their timestamp-based
        // protection. Git events use source ids: multiple accepted actions in
        // the same second are distinct notification candidates.
        if (!eventKey && cand.createdAt <= mark) continue;
        lastNotified.current.set(roomKey, cand.createdAt);
        if (eventKey) notifiedEvents.current.add(eventKey);

        // These page-owned cues work without Notification permission. A batch
        // can contain multiple accepted events, but should produce one sound,
        // not a stack of overlapping clips. The title marker itself is
        // idempotent and only appears while the tab is hidden or unfocused.
        markTabAttention();
        if (soundSettings.enabled && !playedSound) {
          playNotificationSound({ settings: soundSettings });
          playedSound = true;
        }

        if (!canShowOsNotification) continue;

        // Resolve the title (async — needs the author's profile) then fire the
        // OS notification. Errors are swallowed so one bad event never breaks
        // the sink for the rest of the batch.
        void (async () => {
          // A hidden page no longer claims notification ownership (see
          // answerNotificationOwnerQuery), so when Web Push is active the
          // service worker presents this event — showing here too would
          // duplicate it. Without a push subscription the page remains the
          // only notifier for hidden tabs.
          if (document.visibilityState !== "visible" && navigator.serviceWorker?.controller) {
            try {
              const reg = await navigator.serviceWorker.ready;
              if (await reg.pushManager.getSubscription()) return;
            } catch {
              // No subscription info — fall through and show from the page.
            }
          }
          let title: string;
          let body = cand.body;
          const name = await displayNameFor(cand.author);
          if (cand.plane === "dm") {
            if (dmGeneric) {
              // Content-blind: nothing the sender controls (name/avatar/text).
              title = "Message request";
              body = "You have a new message request";
            } else {
              title = `${name} sent you a message`;
              body = body ?? "New direct message";
            }
          } else if (cand.reaction) {
            // A reaction to your own message (V2). Mirrors the NIP-29 native
            // string: "Reacted 👍 to your message".
            title = name;
            body = `Reacted ${cand.reactionEmoji ?? "👍"} to your message`;
          } else if (cand.git) {
            title = `${name} ${cand.git.action} in ${cand.git.repository}`;
            body = cand.git.ticketTitle ?? `New activity in the destination channel`;
          } else {
            title = cand.mention ? `${name} mentioned you` : name;
          }

          try {
            // Profile resolution can outlive a focus or route change. Re-check
            // at presentation time so a notification queued in the background
            // is not shown after the user has focused that conversation.
            if (cand.author === user.pubkey || isRoomActive(roomKey)) return;
            const n = new Notification(title, {
              body,
              icon: "/favicon.png",
              // Armada owns foreground audio so the selected sound isn't
              // doubled by the browser's default notification tone.
              silent: true,
              // Tag by room so repeated messages in the same conversation
              // collapse into one entry.
              tag: roomKey || "armada",
            });
            n.onclick = () => {
              window.focus();
              if (path) c.navigate(path);
              n.close();
            };
          } catch {
            // Some browsers require the service worker to show notifications;
            // there's nothing more to do here (Web Push covers those).
          }
        })();
      }
    });

    // The service worker cannot make the page's exact room-aware decision for
    // encrypted community streams or DMs. Let it hand open-app presentation to
    // this notifier, which suppresses only the focused room and still alerts for
    // other rooms or while Armada is hidden/unfocused. Keep answering the old
    // DM-only query during service-worker/page version transitions.
    const answerNotificationOwnerQuery = (event: MessageEvent) => {
      if (
        event.data?.type !== "armada-notification-owner-query"
        && event.data?.type !== "armada-dm-notification-owner-query"
      ) return;
      const port = event.ports[0];
      if (!port) return;
      // Only while visible: a hidden page may already be frozen by the
      // platform (mobile PWAs especially), unable to receive from the wire or
      // to display (`new Notification` throws on mobile) — claiming ownership
      // there swallows the push entirely. Hidden pages hand presentation back
      // to the service worker.
      const owns = foregroundNotifyIntent()
        && notificationsApiAvailable()
        && Notification.permission === "granted"
        && document.visibilityState === "visible";
      port.postMessage({ owns });
    };
    navigator.serviceWorker?.addEventListener("message", answerNotificationOwnerQuery);

    return () => {
      unregister();
      removeTabAttentionHandlers();
      navigator.serviceWorker?.removeEventListener("message", answerNotificationOwnerQuery);
    };
  }, [user]);
}

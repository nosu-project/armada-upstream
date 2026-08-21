import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useNotifLevels, type NotifLevel } from "@/hooks/useNotifLevels";
import { loadPushPrefs } from "@/lib/pushPrefs";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { parseAuthorEvent, seedAuthorCache, type AuthorResult } from "@/hooks/useAuthor";
import { isForegroundNotifyReady } from "@/hooks/useForegroundNotificationSettings";
import { resolveDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { isRoomActive } from "@/lib/activeRooms";
import { getDisplayName } from "@/lib/getDisplayName";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { queryDm17Conversations } from "@/lib/nip17/dm17Store";
import { dmConvPeers } from "@/lib/nip17/protocol";
import {
  attributedLine,
  mentionPubkeys,
  NOTIFICATION_BADGE_ICON,
  NOTIFICATION_FALLBACK_ICON,
  presentNotification,
  type NotificationMessage,
  type PresentedNotification,
} from "@/lib/notificationPreview";
import { concordRoomIdentity, nip29RoomIdentity } from "@/lib/notificationRoom";
import {
  loadNotificationSoundSettings,
  playNotificationSound,
} from "@/lib/notificationSounds";
import { normalizeRelayUrl } from "@/lib/platform";
import { chatRoute, parseChatRoute } from "@/lib/routes";
import {
  installTabAttentionClearHandlers,
  markTabAttention,
} from "@/lib/tabAttention";
import { registerNotifySink, type NotifyCandidate } from "@/wire/notify";
import { useWireNip29Groups } from "@/wire/useWireNip29Groups";

import type { NostrMetadata } from "@nostrify/nostrify";

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

/**
 * Per-room interruption ceiling, the page-side mirror of `sw.js`'s
 * `ROOM_ALERT_*` and the native service's `ALERT_BURST_MAX`. Past this many
 * ALERTING notifications for one room inside the window, further ones post
 * without a sound.
 */
const ROOM_ALERT_MAX = 5;
const ROOM_ALERT_WINDOW_MS = 120_000;
/** Cap the timestamps one room re-serializes while a flood is live. */
const ROOM_ALERT_MAX_TRACKED = 64;

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
  const { isKnown, knownConversationKeys } = useKnownDmPeers();
  const knownConversationSet = useMemo(
    () => new Set(knownConversationKeys),
    [knownConversationKeys],
  );
  const { data: groupList } = useUserGroupList();
  const { mutedPubkeys } = useMutedPubkeys();

  // Its own ref rather than a field on `ctx`: the sink reads it on every
  // candidate, and it must reflect a mute made moments ago in another tab or
  // surface without the sink being torn down and re-registered.
  const mutedRef = useRef(mutedPubkeys);
  mutedRef.current = mutedPubkeys;

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
    knownConversationSet,
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
    knownConversationSet,
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
  // Per-room alert timestamps (the interruption ceiling) and the recent lines
  // a room's notification body accumulates, both keyed by room key.
  const alertTimes = useRef(new Map<string, number[]>());
  const roomLines = useRef(new Map<string, string[]>());

  // `useKnownDmPeers` supplies durable exact authored/pinned rooms. The sink
  // also refreshes local conversation rows so a just-authored room is known
  // before the index catches up. Keeping room keys (rather than flattening
  // participants) is load-bearing for group privacy.
  const mineConversationKeys = useRef(new Set<string>());
  const mineLoading = useRef(false);

  useEffect(() => {
    if (!user) return;
    if (isNativeRuntime()) return; // native has its own background service

    const removeTabAttentionHandlers = installTabAttentionClearHandlers();

    // Resolve a display name for an author. Tries, in order: the react-query
    // author cache (populated when a profile has been viewed this session) and
    // the shared event store's kind-0 (the wire keeps profiles flowing in) —
    // local reads only, so a missing profile can never delay the notification.
    //
    // An author with no profile held reads "Anonymous", matching the Android
    // service (NotificationRelayService#displayName) and `getDisplayName`'s
    // fallback for a profile that carries no name. A shortened npub here was
    // the identity in name only: the notification is the one surface with no
    // room to resolve it, no avatar beside it and no profile a tap reveals, so
    // it showed a key blob where every other surface shows a word.
    const profileFor = async (pubkey: string): Promise<{ name: string; avatar?: string }> => {
      const present = (metadata: NostrMetadata | undefined) => ({
        name: getDisplayName(metadata, pubkey),
        // https only: a notification icon is loaded by the browser outside the
        // page's control, and an http URL is a mixed-content fetch that simply
        // fails (noisily, in the console) on every deploy this ships to.
        avatar: typeof metadata?.picture === "string" && /^https:\/\//.test(metadata.picture)
          ? metadata.picture
          : undefined,
      });

      if (!pubkey) return { name: "Anonymous" };
      const qc = ctx.current.queryClient;
      const cached = qc.getQueryData<AuthorResult>(["author", pubkey]);
      if (cached?.metadata) return present(cached.metadata);
      if (cached?.event) return present(parseAuthorEvent(cached.event).metadata);

      // Fall back to the local event store (no network) — the profile is very
      // often already here even when no component has subscribed to it.
      try {
        const store = await ctx.current.eventStore;
        const [ev] = await store.query([{ kinds: [0], authors: [pubkey], limit: 1 }]);
        if (ev) {
          const parsed = parseAuthorEvent(ev);
          // Seed the author cache so the next lookup is synchronous.
          seedAuthorCache(qc, pubkey, ev);
          if (parsed.metadata) return present(parsed.metadata);
        }
      } catch {
        // Store unavailable — fall through.
      }

      return { name: "Anonymous" };
    };

    /**
     * The room's title and icon, matching the Android conversation shortcut: a
     * channel shows the COMMUNITY image, a DM the sender's avatar (left to the
     * caller, which already has it). Local reads only; an unresolvable room
     * simply goes unnamed and the presenter falls back to the sender.
     */
    const roomIdentityFor = async (
      cand: NotifyCandidate,
      relayUrl: string | undefined,
      communityId: string | undefined,
    ): Promise<{ title?: string; image?: string }> => {
      try {
        if (cand.plane === "nip29") {
          if (!relayUrl || !cand.groupId) return {};
          const room = await nip29RoomIdentity(relayUrl, cand.groupId);
          return { title: room.title, image: room.iconUrl };
        }
        if (cand.plane === "c2") {
          if (!communityId || !cand.channelIdHex) return {};
          const room = await concordRoomIdentity(communityId, cand.channelIdHex);
          // The icon is an encrypted blob; decrypting it is a warm Cache
          // Storage hit whenever the community is (or has been) on screen.
          const image = room.iconPointer
            ? await resolveDecryptedImage(room.iconPointer).catch(() => undefined)
            : undefined;
          return { title: room.title, image };
        }
      } catch {
        // Never let room decoration cost the notification itself.
      }
      return {};
    };

    /** Resolve the names a message's NIP-27 mentions refer to, locally. */
    const mentionNamesFor = async (content: string | undefined): Promise<Map<string, string>> => {
      const names = new Map<string, string>();
      if (!content) return names;
      const keys = mentionPubkeys(content);
      if (keys.length === 0) return names;
      await Promise.all(keys.map(async (pk) => {
        const { name } = await profileFor(pk);
        // "Anonymous" is an absence, not a name — leaving the raw token stands
        // a better chance of meaning something to the reader.
        if (name && name !== "Anonymous") names.set(pk, name);
      }));
      return names;
    };

    /**
     * Whether this room has already alerted its fill inside the window, the
     * page-side mirror of the service worker's `roomAlertSilent` and the native
     * ALERT_BURST_MAX. Past the ceiling a notification is still shown and its
     * lines still accumulate — it just stops making noise. Records every
     * attempt, so a sustained flood keeps its own window full and stays quiet
     * until it actually stops.
     */
    const roomAlertSilent = (roomKey: string): boolean => {
      const now = Date.now();
      const times = (alertTimes.current.get(roomKey) ?? [])
        .filter((t) => now - t <= ROOM_ALERT_WINDOW_MS);
      const silent = times.length >= ROOM_ALERT_MAX;
      times.push(now);
      alertTimes.current.set(
        roomKey,
        times.length > ROOM_ALERT_MAX_TRACKED ? times.slice(-ROOM_ALERT_MAX_TRACKED) : times,
      );
      return silent;
    };

    /** The room's recent notification lines plus `line`, capped at 5. */
    const appendRoomLine = (roomKey: string, line: string): string[] => {
      const lines = [...(roomLines.current.get(roomKey) ?? []).slice(-4), line];
      roomLines.current.set(roomKey, lines);
      return lines;
    };

    // Reload the conversations the viewer has authored a message in. Called
    // once on mount and again whenever a DM arrives that the current sets don't
    // know: the viewer may have replied since (replying is accepting, but the
    // persisted `acceptedDms` is only written from the compose pane), so one
    // message may present generically before the set catches up — which beats
    // an interval poll, and beats deferring the decision past the point where
    // the `off` policy has to stay silent.
    const refreshMineConversationKeys = () => {
      if (mineLoading.current) return;
      mineLoading.current = true;
      void (async () => {
        try {
          const rows = await queryDm17Conversations(user.pubkey);
          // A written group makes that exact conversation known. It does not
          // make each member a trusted author in an unrelated 1:1.
          mineConversationKeys.current = new Set(
            rows.filter((row) => row.mine).map((row) => row.key),
          );
        } catch {
          // Store unavailable — follows ∪ accepted ∪ pinned still apply.
        } finally {
          mineLoading.current = false;
        }
      })();
    };
    refreshMineConversationKeys();

    const unregister = registerNotifySink((candidates) => {
      const canShowOsNotification = isForegroundNotifyReady();
      const soundSettings = loadNotificationSoundSettings();
      let playedSound = false;

      const c = ctx.current;

      for (const cand of candidates) {
        if (cand.createdAt <= sessionFloor.current) continue;
        // Ingest normally removes self-authored events, but keep the final
        // presentation boundary safe when identity hydration races a live
        // event or another candidate source is added.
        if (cand.author && cand.author === user.pubkey) continue;
        // A muted person must not be able to raise a toast, a sound, or an OS
        // notification — the one place where hiding them from the UI isn't
        // enough, because the notification is the UI coming to find you.
        if (cand.author && mutedRef.current.has(cand.author)) continue;

        // Resolve the fields ingest left for the hook (relay-dependent
        // routing) and the conversation's notification level.
        let roomKey = cand.roomKey;
        let readKey = cand.readKey;
        let path = cand.path;
        let level: NotifLevel;
        // Set when this is a DM from an unknown sender and the request policy is
        // "generic": still cue, but present nothing the sender controls.
        let dmGeneric = false;
        // Filled per plane, for the room's title/image below.
        let relayUrl: string | undefined;
        let communityId: string | undefined;

        if (cand.plane === "nip29") {
          const relay = cand.groupId ? c.relayByGroup.get(cand.groupId) : undefined;
          if (!relay || !cand.groupId) continue; // not a group we're in
          relayUrl = relay;
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
          // Match the DM list: a group containing any muted participant is
          // absent as a whole, even when this particular author is unmuted.
          if (cand.peer && dmConvPeers(cand.peer).some((peer) => mutedRef.current.has(peer))) {
            continue;
          }
          level = cand.peer ? c.dmLevel(cand.peer) : "all";
          // Unknown sender (not followed / accepted / pinned): a stranger picks
          // the message text, their display name and their avatar. Apply the
          // message-request policy before any of it is surfaced — "off" stays
          // silent, "generic" cues without content, "full" notifies as normal.
          const conversationKnown = cand.peer
            ? c.knownConversationSet.has(cand.peer)
              || mineConversationKeys.current.has(cand.peer)
              || dmConvPeers(cand.peer).every((peer) => c.isKnown(peer, false))
            : true;
          if (cand.peer && !conversationKnown) {
            // The viewer may have written to them since the set was loaded.
            refreshMineConversationKeys();
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
          communityId = parsed?.kind === "concord" ? parsed.communityId : "";
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

        // Past this room's interruption ceiling the notification is still shown
        // and its lines still accumulate — it just stops making noise. A
        // channel is writable by anyone holding the invite, so a flood reaches
        // every surface at once; content-blind rate limiting is what keeps that
        // from being a phone (or a laptop) buzzing all night.
        const silent = roomAlertSilent(roomKey);

        // These page-owned cues work without Notification permission. A batch
        // can contain multiple accepted events, but should produce one sound,
        // not a stack of overlapping clips. The favicon badge itself is
        // idempotent and only appears while the tab is hidden or unfocused.
        markTabAttention();
        if (soundSettings.enabled && !playedSound && !silent) {
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
          // Either a fixed presentation (the two shapes that aren't chat
          // messages) or the message the presenter composes below. Composing is
          // deferred past the last active-room check so a notification that
          // turns out not to be shown doesn't leave its line in the room's
          // accumulated body.
          let presented: PresentedNotification | undefined;
          let message: NotificationMessage | undefined;

          if (cand.plane === "dm" && dmGeneric) {
            // Content-blind: nothing the sender controls (name/avatar/text).
            presented = {
              title: "Message request",
              body: "You have a new message request",
              icon: NOTIFICATION_FALLBACK_ICON,
              badge: NOTIFICATION_BADGE_ICON,
            };
          } else if (cand.git) {
            // Repository activity routed into a channel: not a chat message, so
            // it keeps its own shape rather than going through the presenter.
            const { name, avatar } = await profileFor(cand.author);
            presented = {
              title: `${name} ${cand.git.action} in ${cand.git.repository}`,
              body: cand.git.ticketTitle ?? "New activity in the destination channel",
              icon: avatar ?? NOTIFICATION_FALLBACK_ICON,
              badge: NOTIFICATION_BADGE_ICON,
            };
          } else {
            const [{ name, avatar }, room, mentionNames] = await Promise.all([
              profileFor(cand.author),
              roomIdentityFor(cand, relayUrl, communityId),
              mentionNamesFor(cand.content),
            ]);
            message = {
              plane: cand.plane,
              kind: cand.kind,
              // `body` is already truncated and whitespace-collapsed; `content`
              // is the raw text the preview pipeline needs. Encrypted legacy
              // DMs have neither, and fall through to the per-plane default.
              content: cand.content ?? cand.body ?? "",
              authorName: name,
              authorAvatar: avatar,
              roomTitle: room.title,
              roomImage: room.image,
              mention: cand.mention,
              reaction: cand.reaction,
              threadReply: cand.threadReply,
              imetaMime: cand.imetaMime,
              mentionNames,
            };
          }

          try {
            // Profile resolution can outlive a focus or route change. Re-check
            // at presentation time so a notification queued in the background
            // is not shown after the user has focused that conversation.
            if (cand.author === user.pubkey || isRoomActive(roomKey)) return;
            // Accumulate the room's recent lines so a busy conversation reads
            // as a thread — the closest a Web Notification gets to the native
            // MessagingStyle expansion.
            if (message) {
              presented = presentNotification(
                message,
                appendRoomLine(roomKey, attributedLine(message)),
              );
            }
            if (!presented) return;
            const n = new Notification(presented.title, {
              body: presented.body,
              icon: presented.icon,
              badge: presented.badge,
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
      const owns = isForegroundNotifyReady() && document.visibilityState === "visible";
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

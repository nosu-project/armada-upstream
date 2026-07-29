import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { buildConcordSubs } from "@/concord-v1/lib/concordNotifications";
import { useConcordList } from "@/concord-v1/hooks/useConcordList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNotifLevels, type NotifLevel } from "@/hooks/useNotifLevels";
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
import { normalizeRelayUrl, relayToRouteParam } from "@/lib/platform";
import { tryNpubEncode } from "@/lib/safeNip19";
import { registerNotifySink } from "@/wire/notify";
import { useWireNip29Groups } from "@/wire/useWireNip29Groups";

/**
 * useForegroundNotifications
 *
 * The client-side notifier that runs while Armada is OPEN (web / desktop; the
 * native APK uses its background service instead). It surfaces the SAME
 * unread/mention signal the badges already compute — sourced from the wire's
 * ingest, which hands it every live event once — as a real OS
 * `new Notification(...)`.
 *
 * This is complementary to Web Push (closed-tab delivery via the relay
 * gateway): it needs only the Notifications API + permission, so it works in
 * browsers where Web Push is unavailable (Brave with Google push disabled),
 * which otherwise get nothing while the app is open in the background. It fires
 * whether the tab is focused or backgrounded, except for the conversation the
 * user is currently looking at in a focused Armada window (see the active-room
 * gate).
 *
 * Gating (all must pass to notify):
 *   - the master foreground intent is on;
 *   - the conversation's resolved notification level (Discord-style
 *     all/mentions/nothing, `useNotifLevels`, cascading channel → community →
 *     global per-type prefs) admits this message: `all` always, `mentions`
 *     only when it @-mentions you (DMs count), `nothing` never;
 *   - the conversation isn't the one currently on screen (`isRoomActive`);
 *   - the user hasn't already read past it (`useReadState`, NIP-29/DM);
 *   - it's newer than this session's start AND newer than the last thing we
 *     notified for that room (so a backfill / re-ingest never re-alerts).
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
  const { data: groupList } = useUserGroupList();
  const { data: concordList } = useConcordList();

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

  // V1 channel id hex → its community route + display names + `z` set.
  const v1ByChannel = useMemo(() => {
    const m = new Map<
      string,
      { communityId: string; communityName: string; channelName: string; zs: Set<string> }
    >();
    for (const sub of buildConcordSubs(concordList?.list)) {
      for (const k of sub.keys) {
        m.set(k.channelId, {
          communityId: sub.communityId,
          communityName: sub.communityName,
          channelName: sub.channelName,
          zs: new Set(sub.zs),
        });
      }
    }
    return m;
  }, [concordList]);

  // Refs so the (stable) sink reads current values without re-registering on
  // every render — a re-register would drop the wire's reference to the sink.
  const ctx = useRef({
    readState,
    channelLevel,
    concordChannelLevel,
    dmLevel,
    relayByGroup,
    v1ByChannel,
    navigate,
    queryClient,
    eventStore,
  });
  ctx.current = {
    readState,
    channelLevel,
    concordChannelLevel,
    dmLevel,
    relayByGroup,
    v1ByChannel,
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

  useEffect(() => {
    if (!user) return;
    if (isNativeRuntime()) return; // native has its own background service

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

    const unregister = registerNotifySink((candidates) => {
      const intentOn = foregroundNotifyIntent();
      if (!intentOn) return;
      if (!notificationsApiAvailable() || Notification.permission !== "granted") return;

      const c = ctx.current;

      for (const cand of candidates) {
        if (cand.createdAt <= sessionFloor.current) continue;

        // Resolve the fields ingest left for the hook (relay-dependent routing,
        // V1 community routing) and the conversation's notification level.
        let roomKey = cand.roomKey;
        let readKey = cand.readKey;
        let path = cand.path;
        let level: NotifLevel;

        if (cand.plane === "nip29") {
          const relay = cand.groupId ? c.relayByGroup.get(cand.groupId) : undefined;
          if (!relay || !cand.groupId) continue; // not a group we're in
          roomKey = `h:${relay}|${cand.groupId}`;
          readKey = channelReadKey(relay, cand.groupId);
          path = `/s/${relayToRouteParam(relay)}/${encodeURIComponent(cand.groupId)}`;
          level = c.channelLevel(relay, cand.groupId);
        } else if (cand.plane === "dm") {
          level = cand.peer ? c.dmLevel(cand.peer) : "all";
        } else if (cand.plane === "c2") {
          if (!path) continue; // couldn't resolve the community route
          // Recover the community id from the route (`/c/<communityId>/<channel>`)
          // to resolve the per-channel level.
          const parts = path.split("/");
          const communityId = parts[2] ? decodeURIComponent(parts[2]) : "";
          level =
            communityId && cand.channelIdHex
              ? c.concordChannelLevel("c2", communityId, cand.channelIdHex)
              : "all";
        } else {
          // c1: sealed at ingest — generic, no mention detection possible.
          const info = cand.v1ChannelIdHex ? c.v1ByChannel.get(cand.v1ChannelIdHex) : undefined;
          if (!info) continue;
          roomKey = cand.roomKey; // `z:<pseudonym>`
          path = `/c1/${encodeURIComponent(info.communityId)}/${encodeURIComponent(cand.v1ChannelIdHex!)}`;
          level = c.concordChannelLevel("c1", info.communityId, cand.v1ChannelIdHex!);
        }

        // Notification-level gate (Discord-style all/mentions/nothing). For V1,
        // `mention` is always false (sealed), so a `mentions`-level V1 channel
        // never foreground-notifies — matching that we can't see its mentions.
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

        // Resolve the title (async — needs the author's profile) then fire the
        // OS notification. Errors are swallowed so one bad event never breaks
        // the sink for the rest of the batch.
        void (async () => {
          let title: string;
          let body = cand.body;
          if (cand.plane === "c1") {
            const info = cand.v1ChannelIdHex ? c.v1ByChannel.get(cand.v1ChannelIdHex) : undefined;
            title = `New message in ${info?.channelName || info?.communityName || "a channel"}`;
          } else {
            const name = await displayNameFor(cand.author);
            if (cand.plane === "dm") {
              title = `${name} sent you a message`;
              body = body ?? "New direct message";
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
          }

          try {
            const n = new Notification(title, {
              body,
              icon: "/favicon.png",
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

    return unregister;
  }, [user]);
}

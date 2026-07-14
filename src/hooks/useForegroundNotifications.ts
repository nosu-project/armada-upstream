import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { buildConcordSubs } from "@/concord-v1/lib/concordNotifications";
import { useConcordList } from "@/concord-v1/hooks/useConcordList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNotifLevels, type NotifLevel } from "@/hooks/useNotifLevels";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useToast } from "@/hooks/useToast";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { parseAuthorEvent, type AuthorResult } from "@/hooks/useAuthor";
import {
  foregroundNotifyIntent,
  notificationsApiAvailable,
} from "@/hooks/useForegroundNotificationSettings";
import { isRoomActive } from "@/lib/activeRooms";
import { getDisplayName } from "@/lib/getDisplayName";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { normalizeRelayUrl, relayToRouteParam } from "@/lib/platform";
import { registerNotifySink } from "@/wire/notify";

/**
 * useForegroundNotifications
 *
 * The client-side notifier that runs while Armada is OPEN (web / desktop; the
 * native APK uses its background service instead). It surfaces the SAME
 * unread/mention signal the badges already compute — sourced from the wire's
 * ingest, which hands it every live event once — as:
 *
 *   - an in-app TOAST when the tab is focused, and
 *   - a real OS `new Notification(...)` when the tab is BACKGROUNDED.
 *
 * These are complementary to Web Push (closed-tab delivery via the relay
 * gateway): the OS-notification half needs only the Notifications API +
 * permission, so it works in browsers where Web Push is unavailable (Brave with
 * Google push disabled), which otherwise get nothing while the app is open in
 * the background.
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
  const { toast } = useToast();
  const queryClient = useQueryClient();
  useNostr(); // keep within the Nostr provider tree

  const { readState } = useReadState();
  const { channelLevel, concordChannelLevel, dmLevel } = useNotifLevels();
  const { data: groupList } = useUserGroupList();
  const { data: concordList } = useConcordList();

  // groupId → host relay URL (NIP-29 events don't carry their relay).
  const relayByGroup = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groupList?.groups ?? []) {
      const relay = normalizeRelayUrl(g.relay);
      if (relay && g.id) m.set(g.id, relay);
    }
    return m;
  }, [groupList]);

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
    toast,
    queryClient,
  });
  ctx.current = {
    readState,
    channelLevel,
    concordChannelLevel,
    dmLevel,
    relayByGroup,
    v1ByChannel,
    navigate,
    toast,
    queryClient,
  };

  // Session floor: never notify for anything older than the moment the notifier
  // mounted (a fresh login backfilling weeks of history must stay silent).
  const sessionFloor = useRef(Math.floor(Date.now() / 1000));
  // Per-room high-water mark of what we've already notified, so overlapping
  // transports / re-ingests don't double-alert.
  const lastNotified = useRef(new Map<string, number>());

  useEffect(() => {
    if (!user) return;
    if (isNativeRuntime()) return; // native has its own background service

    const displayNameFor = (pubkey: string): string => {
      if (!pubkey) return "Someone";
      const cached = ctx.current.queryClient.getQueryData<AuthorResult>(["author", pubkey]);
      if (cached?.metadata) return getDisplayName(cached.metadata, pubkey);
      if (cached?.event) return getDisplayName(parseAuthorEvent(cached.event).metadata, pubkey);
      return "Someone";
    };

    const unregister = registerNotifySink((candidates) => {
      const intentOn = foregroundNotifyIntent();
      if (!intentOn) return;

      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const c = ctx.current;

      for (const cand of candidates) {
        if (cand.createdAt <= sessionFloor.current) continue;

        // Resolve the fields ingest left for the hook (relay-dependent routing,
        // V1 community routing) and the conversation's notification level.
        let roomKey = cand.roomKey;
        let readKey = cand.readKey;
        let path = cand.path;
        let level: NotifLevel;
        let title = "";

        if (cand.plane === "nip29") {
          const relay = cand.groupId ? c.relayByGroup.get(cand.groupId) : undefined;
          if (!relay || !cand.groupId) continue; // not a group we're in
          roomKey = `h:${relay}|${cand.groupId}`;
          readKey = channelReadKey(relay, cand.groupId);
          path = `/s/${relayToRouteParam(relay)}/${encodeURIComponent(cand.groupId)}`;
          level = c.channelLevel(relay, cand.groupId);
          title = cand.mention ? `${displayNameFor(cand.author)} mentioned you` : displayNameFor(cand.author);
        } else if (cand.plane === "dm") {
          level = cand.peer ? c.dmLevel(cand.peer) : "all";
          title = `${displayNameFor(cand.author)} sent you a message`;
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
          title = cand.mention
            ? `${displayNameFor(cand.author)} mentioned you`
            : displayNameFor(cand.author);
        } else {
          // c1: sealed at ingest — generic, no mention detection possible.
          const info = cand.v1ChannelIdHex ? c.v1ByChannel.get(cand.v1ChannelIdHex) : undefined;
          if (!info) continue;
          roomKey = cand.roomKey; // `z:<pseudonym>`
          path = `/c1/${encodeURIComponent(info.communityId)}/${encodeURIComponent(cand.v1ChannelIdHex!)}`;
          level = c.concordChannelLevel("c1", info.communityId, cand.v1ChannelIdHex!);
          title = `New message in ${info.channelName || info.communityName}`;
        }

        // Notification-level gate (Discord-style all/mentions/nothing). For V1,
        // `mention` is always false (sealed), so a `mentions`-level V1 channel
        // never foreground-notifies — matching that we can't see its mentions.
        if (!levelAdmits(level, cand.mention)) continue;

        // Read-state gate (NIP-29 / DM have a useReadState entry). If the user
        // already read past this message, don't notify.
        if (readKey && (c.readState[readKey] ?? 0) >= cand.createdAt) continue;

        // On-screen suppression: the room the user is looking at (tab visible).
        if (isRoomActive(roomKey)) continue;

        // Dedupe against what we've already surfaced for this room.
        const mark = lastNotified.current.get(roomKey) ?? 0;
        if (cand.createdAt <= mark) continue;
        lastNotified.current.set(roomKey, cand.createdAt);

        const body = cand.body ?? (cand.plane === "dm" ? "New direct message" : undefined);

        if (hidden && notificationsApiAvailable() && Notification.permission === "granted") {
          // Backgrounded tab → OS notification. Tag by room so repeated messages
          // in the same conversation collapse into one entry.
          try {
            const n = new Notification(title, {
              body,
              icon: "/favicon.png",
              tag: roomKey || "armada",
            });
            n.onclick = () => {
              window.focus();
              if (path) c.navigate(path);
              n.close();
            };
          } catch {
            // Some browsers throw when constructing Notification directly
            // (they require the SW). Fall back to a toast silently.
            c.toast({ title, description: body });
          }
        } else if (!hidden) {
          // Focused tab → in-app toast.
          c.toast({ title, description: body });
        }
        // Hidden but no permission / API: nothing to do here (Web Push, if
        // available and subscribed, covers the closed/background case).
      }
    });

    return unregister;
  }, [user]);
}

import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { buildConcordSubs } from "@/concord-v1/lib/concordNotifications";
import { useConcordList } from "@/concord-v1/hooks/useConcordList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutes } from "@/hooks/useMutes";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useToast } from "@/hooks/useToast";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { parseAuthorEvent, type AuthorResult } from "@/hooks/useAuthor";
import {
  foregroundNotifyIntent,
  notificationsApiAvailable,
} from "@/hooks/useForegroundNotificationSettings";
import { DEFAULT_PUSH_PREFS, type PushPrefs } from "@/hooks/usePushNotifications";
import { isRoomActive } from "@/lib/activeRooms";
import { getDisplayName } from "@/lib/getDisplayName";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { normalizeRelayUrl, relayToRouteParam } from "@/lib/platform";
import { registerNotifySink, type NotifyCandidate } from "@/wire/notify";

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
 *   - the per-type preference for this kind is on (reuses `PushPrefs`);
 *   - the conversation isn't muted (`useMutes`, Discord-style: mentions pierce);
 *   - the conversation isn't the one currently on screen (`isRoomActive`);
 *   - the user hasn't already read past it (`useReadState`, NIP-29/DM);
 *   - it's newer than this session's start AND newer than the last thing we
 *     notified for that room (so a backfill / re-ingest never re-alerts).
 */

/** Read the current per-type prefs (shared with Web Push / native). */
function loadPrefs(): PushPrefs {
  try {
    const raw = localStorage.getItem("armada:push-prefs");
    if (raw) return { ...DEFAULT_PUSH_PREFS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...DEFAULT_PUSH_PREFS };
}

/** Which per-type pref governs a candidate. */
function prefKeyFor(c: NotifyCandidate): keyof PushPrefs {
  if (c.plane === "dm") return "directMessages";
  // Mentions are their own toggle; everything else is "all channel messages".
  return c.mention ? "mentions" : "allGroupMessages";
}

export function useForegroundNotifications(): void {
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  useNostr(); // keep within the Nostr provider tree

  const { readState } = useReadState();
  const { isChannelMuted, isConcordChannelMuted } = useMutes();
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
    isChannelMuted,
    isConcordChannelMuted,
    relayByGroup,
    v1ByChannel,
    navigate,
    toast,
    queryClient,
  });
  ctx.current = {
    readState,
    isChannelMuted,
    isConcordChannelMuted,
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
      const prefs = loadPrefs();
      const intentOn = foregroundNotifyIntent();
      if (!intentOn) return;

      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const c = ctx.current;

      for (const cand of candidates) {
        if (cand.createdAt <= sessionFloor.current) continue;

        // Resolve the fields ingest left for the hook (relay-dependent routing,
        // V1 community routing), and the mute gate, per plane.
        let roomKey = cand.roomKey;
        let readKey = cand.readKey;
        let path = cand.path;
        let muted = false;
        let title = "";

        if (cand.plane === "nip29") {
          const relay = cand.groupId ? c.relayByGroup.get(cand.groupId) : undefined;
          if (!relay || !cand.groupId) continue; // not a group we're in
          roomKey = `h:${relay}|${cand.groupId}`;
          readKey = channelReadKey(relay, cand.groupId);
          path = `/s/${relayToRouteParam(relay)}/${encodeURIComponent(cand.groupId)}`;
          muted = c.isChannelMuted(relay, cand.groupId);
          title = cand.mention ? `${displayNameFor(cand.author)} mentioned you` : displayNameFor(cand.author);
        } else if (cand.plane === "dm") {
          title = `${displayNameFor(cand.author)} sent you a message`;
        } else if (cand.plane === "c2") {
          if (!path) continue; // couldn't resolve the community route
          if (cand.channelIdHex) {
            // c2 read map is keyed by channel id hex; there's no useReadState
            // entry, so unread gating for c2 relies on active-room + floor.
            muted = false; // per-channel c2 mute needs community id; skip fine-grained here
          }
          title = cand.mention
            ? `${displayNameFor(cand.author)} mentioned you`
            : displayNameFor(cand.author);
        } else {
          // c1: sealed at ingest — generic, "all messages" only, no mention.
          const info = cand.v1ChannelIdHex ? c.v1ByChannel.get(cand.v1ChannelIdHex) : undefined;
          if (!info) continue;
          roomKey = cand.roomKey; // `z:<pseudonym>`
          path = `/c1/${encodeURIComponent(info.communityId)}/${encodeURIComponent(cand.v1ChannelIdHex!)}`;
          muted = c.isConcordChannelMuted("c1", info.communityId, cand.v1ChannelIdHex!);
          title = `New message in ${info.channelName || info.communityName}`;
        }

        // Preference gate (mentions always pierce a channel mute, Discord-style).
        const prefKey = prefKeyFor(cand);
        if (!prefs[prefKey]) continue;
        if (muted && !cand.mention) continue;

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

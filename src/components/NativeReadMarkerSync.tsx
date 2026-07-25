import { useCallback, useEffect, useRef } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  channelReadKey,
  concord1ReadKey,
  concord2ReadKey,
  dmReadKey,
  useReadState,
} from "@/hooks/useReadState";
import { ArmadaNotification } from "@/lib/nativeNotifications";

/**
 * Headless mount that applies the Android background service's "Mark read"
 * markers to the in-app read state. When the user taps a notification's "Mark
 * read" action, the service dismisses it and records a durable marker; this
 * drains those markers on open/resume and advances the matching conversation's
 * read state so the badge clears.
 *
 * Every room type routes into the one shared ReadStateProvider map (which
 * persists locally and syncs via the encrypted NIP-78 settings event), keyed
 * by `c1:<channelId>` / `c2:<channelId>` / `relayUrl::groupId` / `dm:<peer>`.
 * All stamps are monotonic, so a lost or replayed marker is harmless. Inert
 * off Android (the plugin call no-ops). Must sit under ReadStateProvider.
 */
export function NativeReadMarkerSync() {
  const { user } = useCurrentUser();
  const { markRead } = useReadState();

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android" || !user) return;
    let cancelled = false;

    const apply = async () => {
      let markers: Array<{ room: string; ts: number; channelId?: string }>;
      try {
        ({ markers } = await ArmadaNotification.drainReadMarkers());
      } catch {
        return; // bridge unavailable / older native binary
      }
      if (cancelled || !markers || markers.length === 0) return;

      for (const m of markers) {
        const ts = Math.floor(m.ts);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        const { room } = m;
        try {
          if (room.startsWith("c2:")) {
            markRead(concord2ReadKey(room.slice(3)), ts);
          } else if (room.startsWith("z:")) {
            // The V1 room key is a per-epoch pseudonym; the native side resolves
            // it to the channel id (read state is keyed by channel).
            if (m.channelId) markRead(concord1ReadKey(m.channelId), ts);
          } else if (room.startsWith("h:")) {
            // `h:<relayUrl>|<groupId>` — split on the last `|` (relay URLs and
            // group ids don't contain it) and rebuild the `relayUrl::groupId` key.
            const rest = room.slice(2);
            const i = rest.lastIndexOf("|");
            if (i > 0) markRead(channelReadKey(rest.slice(0, i), rest.slice(i + 1)), ts);
          } else if (room.startsWith("dm:")) {
            markRead(dmReadKey(room.slice(3)), ts);
          }
          // dm17:opaque and anything unattributable: dismissed natively, no
          // conversation to advance.
        } catch {
          // A single bad marker mustn't abort the rest.
        }
      }
    };

    void apply();

    let handle: { remove: () => void } | undefined;
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void apply();
    })
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [user, markRead]);

  return null;
}

/**
 * Read-state keys the Android service can attribute to a posted notification:
 * DMs, Concord V1/V2 channels, and NIP-29 channels (`<relayUrl>::<groupId>`).
 * The Concord V2 mention (`c2m:`) and thread (`c2t:`) sub-keys never key a
 * notification room, so they're dropped (a channel's notifications clear on its
 * channel-level `c2:` read). `c2:`.startsWith excludes both by construction.
 */
function dismissibleReadKey(key: string): boolean {
  return (
    key.startsWith("dm:") ||
    key.startsWith("c1:") ||
    key.startsWith("c2:") ||
    key.includes("::")
  );
}

/**
 * Headless mount (reverse of {@link NativeReadMarkerSync}): pushes the in-app
 * read state down to the Android background service so it dismisses tray
 * notifications for conversations already read — whether read here or synced in
 * from another device (the read state mirrors through the encrypted NIP-78
 * settings). The service cancels a room's notification once its newest notified
 * message is at/older than the read stamp, leaving rooms with newer unread
 * messages up. Inert off Android (the plugin call no-ops). Must sit under
 * ReadStateProvider.
 */
export function NativeReadDismiss() {
  const { readState } = useReadState();
  const readStateRef = useRef(readState);
  readStateRef.current = readState;

  const send = useCallback(() => {
    const markers = Object.entries(readStateRef.current)
      .filter(([room]) => dismissibleReadKey(room))
      .map(([room, ts]) => ({ room, ts: Math.floor(ts) }))
      .filter((m) => Number.isFinite(m.ts) && m.ts > 0);
    if (markers.length === 0) return;
    ArmadaNotification.dismissRead({ markers }).catch(() => {
      // Bridge unavailable / older native binary — the notification just stays
      // until the user swipes or taps it. Read state is unaffected.
    });
  }, []);

  // Debounced push on every read-state advance (opening a conversation, or a
  // hydrate merge from synced settings settles into one bridge call).
  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    const t = setTimeout(send, 400);
    return () => clearTimeout(t);
  }, [readState, send]);

  // Re-push on resume: a notification may have been posted while backgrounded
  // for a conversation that's already read (e.g. read on another device and
  // synced in), which no in-session read-state change would otherwise clear.
  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    let cancelled = false;
    let handle: { remove: () => void } | undefined;
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) send();
    })
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [send]);

  return null;
}

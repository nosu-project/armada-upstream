import { useCallback, useEffect, useRef } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  channelReadKey,
  concordReadKey,
  dmReadKey,
  useReadState,
} from "@/hooks/useReadState";
import { ArmadaNotification } from "@/lib/nativeNotifications";

/**
 * Applies the Android service's "Mark read" markers to in-app read state on
 * open/resume. Keys: `c2:<channelId>` / `relayUrl::groupId` / `dm:<peer>`.
 * Stamps are monotonic, so replays are harmless. Must sit under ReadStateProvider.
 */
export function NativeReadMarkerSync() {
  const { user } = useCurrentUser();
  const { markRead } = useReadState();

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android" || !user) return;
    let cancelled = false;

    const apply = async () => {
      let markers: Array<{ room: string; ts: number }>;
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
            markRead(concordReadKey(room.slice(3)), ts);
          } else if (room.startsWith("h:")) {
            // `h:<relayUrl>|<groupId>`: split on the last `|` (neither contains it).
            const rest = room.slice(2);
            const i = rest.lastIndexOf("|");
            if (i > 0) markRead(channelReadKey(rest.slice(0, i), rest.slice(i + 1)), ts);
          } else if (room.startsWith("dm:")) {
            markRead(dmReadKey(room.slice(3)), ts);
          }
          // dm17:opaque and unattributable markers: nothing to advance.
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
 * Read keys that can match a notification room: DMs, `c2:` channels, and
 * `<relayUrl>::<groupId>`. `c2m:`/`c2t:` sub-keys are excluded.
 */
function dismissibleReadKey(key: string): boolean {
  return (
    key.startsWith("dm:") ||
    key.startsWith("c2:") ||
    key.includes("::")
  );
}

/**
 * Reverse of {@link NativeReadMarkerSync}: pushes read state to the Android
 * service so it dismisses notifications for read conversations (including
 * ones read on other devices). Must sit under ReadStateProvider.
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
      // Bridge unavailable / older native binary.
    });
  }, []);

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    const t = setTimeout(send, 400);
    return () => clearTimeout(t);
  }, [readState, send]);

  // Re-push on resume: notifications posted while backgrounded may already be read.
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

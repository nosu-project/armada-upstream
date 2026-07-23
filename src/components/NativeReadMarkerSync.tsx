import { useEffect } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

import { markConcord1Read } from "@/concord-v1/lib/readState1";
import { markConcord2Read } from "@/concord-v2/lib/readState2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { channelReadKey, dmReadKey, useReadState } from "@/hooks/useReadState";
import { ArmadaNotification } from "@/lib/nativeNotifications";

/**
 * Headless mount that applies the Android background service's "Mark read"
 * markers to the in-app read state. When the user taps a notification's "Mark
 * read" action, the service dismisses it and records a durable marker; this
 * drains those markers on open/resume and advances the matching conversation's
 * read state so the badge clears.
 *
 * Read state lives in two systems, so each room type routes differently:
 *   - Concord V1/V2 → per-channel IndexedDB store (markConcord1Read/
 *     markConcord2Read), keyed by channel id;
 *   - NIP-29 groups + DMs → the reactive ReadStateProvider map (markRead),
 *     keyed by `relayUrl::groupId` / `dm:<peer>`.
 * All are monotonic, so a lost or replayed marker is harmless. Inert off
 * Android (the plugin call no-ops). Must sit under ReadStateProvider.
 */
export function NativeReadMarkerSync() {
  const { user } = useCurrentUser();
  const { markRead } = useReadState();

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android" || !user) return;
    const pubkey = user.pubkey;
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
            await markConcord2Read(pubkey, room.slice(3), ts);
          } else if (room.startsWith("z:")) {
            // The V1 room key is a per-epoch pseudonym; the native side resolves
            // it to the channel id (read state is keyed by channel).
            if (m.channelId) await markConcord1Read(pubkey, m.channelId, ts);
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

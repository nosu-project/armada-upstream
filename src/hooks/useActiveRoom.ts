import { useEffect } from "react";

import { hasNativeNotificationService } from "@/lib/platform";
import { setActiveRooms as setWebActiveRooms } from "@/lib/activeRooms";
import { ArmadaNotification } from "@/lib/nativeNotifications";
import { usePageCovered } from "@/lib/settingsOverlay";

/**
 * Tell the native background notification service which room(s) the WebView is
 * currently showing, so it can suppress redundant notifications for that room
 * (the live `relayEvent` feed already paints the message in
 * the timeline).
 *
 * The roomKeys are the service's stable per-conversation identifiers (the same
 * shapes `enqueueRoomMessage` uses on the Java side):
 *   - NIP-29 group: `h:<relayUrl>|<groupId>`
 *   - Concord:      `c2:<channelIdHex>`
 *   - DM:           `dm:<conversationKey>` — the participant set (`dmConvKey`),
 *                   which for a 1:1 is just the peer's pubkey
 *
 * Thread-level keys (`<roomKey>:t:<rootId>`) suppress notifications for a
 * specific open thread panel. Mentions still notify even on an active room.
 *
 * The service holds the keys only on its live instance and expires them unless
 * this visible, focused WebView refreshes a short heartbeat. That covers the
 * Android case where the Activity dies without getting a blur/unmount callback
 * while the foreground relay service survives.
 *
 * Re-publishes on visibility and window-focus changes so backgrounding the app
 * or moving to another window clears the active set, while foregrounding
 * restores it. Native-only for the background SERVICE; on web/desktop it also
 * mirrors the keys into the in-process active-room registry
 * ({@link setWebActiveRooms}) so the page's foreground notifier
 * (`useForegroundNotifications`) suppresses notifications only while the user
 * is actually looking at the conversation.
 *
 * While Settings draws over the page (`usePageCovered`) the conversation is
 * mounted but not on screen, so the active set is cleared until it closes.
 *
 * @param roomKeys stable conversation identifiers the WebView is currently
 *                 showing. When empty/undefined, the active set is cleared.
 */
export function useActiveRoom(...roomKeys: Array<string | string[] | undefined>): void {
  const keys = roomKeys
    .flat()
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => k.length > 0);

  const sig = keys.join("\u0001");
  const covered = usePageCovered();

  // Unmount-only cleanup: clear the active set when the component truly
  // unmounts (navigates away from the chat screen). This is a SEPARATE effect
  // with `[]` deps so it does NOT fire on every `sig` change — clearing on
  // every dependency change created a race window where the service briefly
  // had no active keys and let notifications through.
  useEffect(() => {
    return () => {
      setWebActiveRooms([]);
      if (hasNativeNotificationService()) {
        ArmadaNotification.setActiveRooms({ roomKeys: [] }).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    const publish = () => {
      const active = !covered && document.visibilityState === "visible" && document.hasFocus();
      const next = active ? sig.split("\u0001").filter((k) => k.length > 0) : [];
      // In-process (web/desktop foreground notifier) — cheap, always.
      setWebActiveRooms(next);
      // Native background service — only where it exists.
      if (hasNativeNotificationService()) {
        ArmadaNotification.setActiveRooms({ roomKeys: next }).catch((err) => {
          console.warn("[active-room] setActiveRooms failed:", err);
        });
      }
    };

    publish();
    // Browser timers pause in the background, which is useful here: if Android
    // kills the WebView without delivering blur/unmount, native lets the last
    // active-room set expire instead of suppressing that room indefinitely.
    const heartbeat = window.setInterval(publish, 10_000);
    document.addEventListener("visibilitychange", publish);
    window.addEventListener("focus", publish);
    window.addEventListener("blur", publish);
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", publish);
      window.removeEventListener("focus", publish);
      window.removeEventListener("blur", publish);
    };
  }, [sig, covered]);

}

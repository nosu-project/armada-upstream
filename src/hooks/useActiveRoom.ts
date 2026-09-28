import { useEffect } from "react";

import { hasNativeNotificationService } from "@/lib/platform";
import { setActiveRooms as setWebActiveRooms } from "@/lib/activeRooms";
import { ArmadaNotification } from "@/lib/nativeNotifications";
import { usePageCovered } from "@/lib/settingsOverlay";

/**
 * Tell the native notification service which room(s) are on screen, to suppress
 * redundant notifications. roomKeys must match `enqueueRoomMessage` (Java):
 *   - NIP-29 group: `h:<relayUrl>|<groupId>`
 *   - Concord:      `c2:<channelIdHex>`
 *   - DM:           `dm:<conversationKey>` (`dmConvKey`; a 1:1 is the peer pubkey)
 * Thread keys are `<roomKey>:t:<rootId>`. Mentions still notify.
 *
 * Native keys expire without a heartbeat from a visible, focused WebView (the
 * Activity can die without an unmount). Re-published on visibility/focus; on
 * web also mirrored to {@link setWebActiveRooms}. Cleared while Settings covers the page.
 *
 * @param roomKeys conversation identifiers on screen; empty/undefined clears.
 */
export function useActiveRoom(...roomKeys: Array<string | string[] | undefined>): void {
  const keys = roomKeys
    .flat()
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => k.length > 0);

  const sig = keys.join("\u0001");
  const covered = usePageCovered();

  // Unmount-only cleanup, separate with `[]` deps: clearing on every `sig` change
  // briefly left no active keys and let notifications through.
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
      setWebActiveRooms(next);
      if (hasNativeNotificationService()) {
        ArmadaNotification.setActiveRooms({ roomKeys: next }).catch((err) => {
          console.warn("[active-room] setActiveRooms failed:", err);
        });
      }
    };

    publish();
    // Timers pause in the background, so if Android kills the WebView silently,
    // native lets the active set expire.
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

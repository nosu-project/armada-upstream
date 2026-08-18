/**
 * Withdraw Web Push notifications the service worker showed for a conversation
 * the user has since read — the browser mirror of the Android background
 * service's read-state dismissal (`NotificationRelayService.applyReadStateDismiss`,
 * feeding `applyDismissRead`). Driven from {@link ReadStateProvider} whenever
 * read-state advances: a read made here (`markRead`) or one synced in from
 * another device while this page is open (`hydrate`).
 *
 * BUDGET-FREE by construction: this only CLOSES notifications already on
 * screen, it never shows one — so unlike a read-state Web Push it costs nothing
 * against Apple's silent-push allowance (`sw.js`'s APPLE_SILENT_BUDGET) and can
 * never nudge Safari toward revoking the subscription.
 *
 * The mapping from a read-state key (`ReadStateContext`) to the notification
 * `tag` the worker tagged its notification with (`pushRuntime.ts` present()):
 *
 *   - `dm:<pk>`        → `dm-<pk>`               (prepareDm)
 *   - `c2:<channelId>` → `c2:<channelId>`        (prepareConcord — verbatim)
 *   - `<relay>::<gid>` → `h:<gid>`               (prepareGroup — relay-less)
 *
 * The Concord mentions/thread/invite keys (`c2m:`/`c2t:`/`c2inv`) raise no
 * per-conversation notification, so they map to nothing and close nothing.
 *
 * NIP-29's tag drops the relay (the worker has only the subscription's whole
 * relay list, not the event's source relay — see prepareGroup), so the reverse
 * direction is by group id alone: a read of `<relay>::<gid>` closes `h:<gid>`.
 * With the same id on two relays that can over-close, exactly as the worker's
 * own relay-less tagging already collapses them — acceptable, and a dropped
 * notification is only a notification.
 */

import type { ReadStateMap } from "@/contexts/ReadStateContext";

/**
 * Whether a notification tagged `tag`, showing a newest message at `tsMs`
 * (`Notification.timestamp`, ms), is covered by `readState` — i.e. the user has
 * read at or past everything it shows and it is no longer news.
 */
export function coveredByReadState(tag: string, tsMs: number, readState: ReadStateMap): boolean {
  const readAtOrPast = (key: string): boolean => (readState[key] ?? 0) * 1000 >= tsMs;

  if (tag.startsWith("dm-")) return readAtOrPast(`dm:${tag.slice(3)}`);
  // concordReadKey() and prepareConcord's tag are the same string.
  if (tag.startsWith("c2:")) return readAtOrPast(tag);
  if (tag.startsWith("h:")) {
    const gid = tag.slice(2);
    // NIP-29 read keys carry the relay (`<relay>::<gid>`); the tag doesn't. Any
    // relay's read of this group id covers it. `lastIndexOf` so an IPv6 relay
    // host (`wss://[::1]`) can't be mistaken for the `::` separator.
    for (const [key, ts] of Object.entries(readState)) {
      const sep = key.lastIndexOf("::");
      if (sep >= 0 && key.slice(sep + 2) === gid && ts * 1000 >= tsMs) return true;
    }
    return false;
  }
  // Request pings, the quiet keep-alive, anything else: never read-dismissed.
  return false;
}

/**
 * Close every service-worker notification now covered by `readState`. One
 * `getNotifications()` call (the tray holds few), each checked against the map;
 * a notification without an explicit timestamp reports its creation time, which
 * is close enough to the message it announced.
 *
 * Best-effort on every axis: no service worker, no `getNotifications` (older
 * Safari), or a throwing close just leaves the tray as it is — the notification
 * lingers until tapped, exactly as before this existed.
 */
export async function dismissReadNotifications(readState: ReadStateMap): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || typeof reg.getNotifications !== "function") return;
    const notifications = await reg.getNotifications();
    for (const n of notifications) {
      // `Notification.timestamp` is widely supported but absent from the TS DOM
      // lib; it defaults to the creation time when the notification set none.
      const stamp = (n as Notification & { timestamp?: number }).timestamp;
      const tsMs = typeof stamp === "number" ? stamp : Date.now();
      if (coveredByReadState(n.tag, tsMs, readState)) n.close();
    }
  } catch {
    // getNotifications/close unsupported or the registration is gone.
  }
}

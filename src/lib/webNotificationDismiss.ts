import type { ReadStateMap } from "@/contexts/ReadStateContext";

/**
 * The read-state key for a notification room, or undefined when the room isn't
 * attributable. Same mapping as `NotificationRelayService.readKeyForRoom`:
 * `dm:`/`c2:` unchanged, `h:<relayUrl>|<groupId>` → `<relayUrl>::<groupId>`.
 */
export function readKeyForRoom(roomKey: unknown): string | undefined {
  if (typeof roomKey !== "string") return undefined;
  if (roomKey.startsWith("dm:") || roomKey.startsWith("c2:")) return roomKey;
  if (roomKey.startsWith("h:")) {
    const rest = roomKey.slice(2);
    const i = rest.lastIndexOf("|");
    return i > 0 ? `${rest.slice(0, i)}::${rest.slice(i + 1)}` : undefined;
  }
  return undefined;
}

interface ShownNotification {
  data?: unknown;
  close(): void;
}

/**
 * Close each shown notification whose room is read up to its newest message.
 * A room with a newer unread message stays up.
 */
export function closeReadNotifications(shown: readonly ShownNotification[], readState: ReadStateMap): void {
  for (const n of shown) {
    const data = n.data && typeof n.data === "object" ? n.data as { roomKey?: unknown; newestMs?: unknown } : {};
    const key = readKeyForRoom(data.roomKey);
    if (!key || typeof data.newestMs !== "number") continue;
    const readSec = readState[key];
    if (typeof readSec === "number" && readSec * 1000 >= data.newestMs) n.close();
  }
}

/** {@link closeReadNotifications} over the service worker's notifications. Best-effort. */
export async function dismissReadWebNotifications(readState: ReadStateMap): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration || typeof registration.getNotifications !== "function") return;
    closeReadNotifications(await registration.getNotifications(), readState);
  } catch {
    // No introspection; notifications stay until tapped.
  }
}

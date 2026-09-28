/**
 * In-process "which conversation is on screen" registry for the web/desktop
 * foreground notifier (native uses its foreground service instead). Written by
 * `useActiveRoom`, which clears it when the window is backgrounded/unfocused.
 *
 * Room keys match the native service's shapes:
 *   - NIP-29 group: `h:<relayUrl>|<groupId>`
 *   - Concord:      `c2:<channelIdHex>`
 *   - DM:           `dm:<peerPubkey>`
 */

let active = new Set<string>();
const listeners = new Set<() => void>();

/** Replace the active room-key set. Notifies subscribers on any change. */
export function setActiveRooms(keys: Iterable<string>): void {
  const next = new Set<string>();
  for (const k of keys) if (k) next.add(k);
  if (next.size === active.size && [...next].every((k) => active.has(k))) return;
  active = next;
  for (const l of listeners) {
    try {
      l();
    } catch {
      // A listener must never break the registry for the others.
    }
  }
}

/** Whether the room is on screen in the visible, focused Armada window. */
export function isRoomActive(key: string | undefined): boolean {
  if (!key) return false;
  if (typeof document !== "undefined") {
    if (document.visibilityState !== "visible") return false;
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
  }
  return active.has(key);
}

/**
 * Shared "which conversation is on screen" registry.
 *
 * The native APK pushes the active room keys into its foreground service
 * (`setActiveRooms`, see nativeNotifications.ts) so it can suppress redundant
 * tray entries for a conversation the user is already looking at. On web /
 * desktop there is no such service — the foreground notifier
 * (`useForegroundNotifications`) runs in the page — so it needs the same
 * signal in-process. This module is that single source of truth: `useActiveRoom`
 * writes to it, the web foreground notifier reads from it.
 *
 * Room keys use the SAME stable shapes the native service uses (see
 * useActiveRoom's docstring):
 *   - NIP-29 group: `h:<relayUrl>|<groupId>`
 *   - Concord V1:   `z:<pseudonym>`
 *   - Concord V2:   `c2:<channelIdHex>`
 *   - DM:           `dm:<peerPubkey>`
 *
 * The set is cleared whenever the document is backgrounded or its window loses
 * focus. The notifier also checks both signals directly, but keeping the set
 * empty while the user is elsewhere means the last-open room still notifies.
 * It is the responsibility of `useActiveRoom` to keep it current.
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

/** Subscribe to active-room-set changes. Returns an unsubscribe. */
export function onActiveRoomsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * The Web Notification `tag` the desktop shell may use for a room.
 *
 * Electron presents a renderer `new Notification()` on Windows through the
 * WinRT toast API and sets the toast's `Tag` to Chromium's INTERNAL
 * notification id — not the web `tag`, but the id Chromium derives from it:
 * `n#<origin>#<token>`, where the token IS the web tag whenever one is given
 * (Blink substitutes a random token only for an untagged notification). A
 * toast tag longer than 64 characters fails `put_Tag` with "The size of the
 * notification tag is too large", the toast is never shown, and nothing
 * reaches the Action Center; the renderer sees only an `error` event.
 *
 * Armada tags each notification with its room key so a busy conversation
 * collapses into one entry, and a room key is `c2:<64 hex>` or `dm:<64 hex>`:
 * under `n#app://armada#` that is 82 characters, so on Windows every
 * notification failed this way — silently, and independently of the
 * AppUserModelId the shell also had to set. Linux (libnotify) and macOS have
 * no such limit, which is why the same build notified there.
 *
 * So on desktop the tag is a fixed-width digest of the room key: still one
 * per room, so collapsing works, and short enough that the id Windows sees
 * stays under the limit with room to spare. The web keeps the raw room key —
 * browsers hash the id themselves before Windows sees it, and the service
 * worker matches page notifications by that same raw tag.
 */

/** Chromium's non-persistent id prefix for the desktop shell's origin. */
export const DESKTOP_NOTIFICATION_ID_PREFIX = "n#app://armada#";

/** Windows' toast tag limit (Windows 10 build 19041 and later; 16 before). */
export const WINDOWS_TOAST_TAG_MAX = 64;

/** Hex digits kept: 32 (128 bits) — no two rooms will share a tag. */
const DIGEST_HEX = 32;

/** The notification id Chromium hands Electron for a tagged notification. */
export function chromiumNotificationId(tag: string): string {
  return `${DESKTOP_NOTIFICATION_ID_PREFIX}${tag}`;
}

export function desktopNotificationTag(roomKey: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(roomKey || "armada"))).slice(0, DIGEST_HEX);
}

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * The Web Notification `tag` for a room on desktop. On Windows, Electron sets
 * the WinRT toast `Tag` to Chromium's internal id `n#<origin>#<tag>`, and
 * toast tags over 64 chars fail silently (never shown). Room keys
 * (`c2:<64 hex>`) exceed that, so desktop uses a fixed-width digest (still
 * one per room). The web keeps the raw key (browsers hash it; the service
 * worker matches on it).
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

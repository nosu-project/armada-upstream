"use strict";

// Permissions our own renderer may use: media (mic/camera for LiveKit voice),
// screen share, notifications, fullscreen, clipboard and pointer lock.
const APP_PERMISSIONS = new Set([
  "media", // getUserMedia (microphone + camera)
  "display-capture", // getDisplayMedia (screen share)
  "notifications",
  "fullscreen",
  "clipboard-read",
  "clipboard-sanitized-write",
  "pointerLock",
]);

// What a cross-origin subframe the app embeds (YouTube, Streamable, Spotify, a
// Mini App) may use. Electron reports such a request under the IFRAME's
// origin, so an origin check alone denied the YouTube player its fullscreen
// and copy-link buttons. Chromium has already applied the iframe's `allow`
// attribute before the handler runs, so which frames get fullscreen is the
// app's markup's call; this list only bounds what the markup can hand out —
// never a microphone, camera or screen to a foreign origin.
const DELEGATED_PERMISSIONS = new Set(["fullscreen"]);

// Clipboard write is narrower: only the fixed provider players the app itself
// frames with `clipboard-write` (their copy-link buttons). A Mini App's code
// is whatever its sender wrote, and it must not be able to write the desktop
// clipboard, so this is an origin allowlist rather than a markup decision.
const CLIPBOARD_EMBED_ORIGINS = new Set([
  "https://www.youtube-nocookie.com",
  "https://www.youtube.com",
  "https://open.spotify.com",
]);

function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

function delegatedToEmbed(permission, embedUrl) {
  if (DELEGATED_PERMISSIONS.has(permission)) return true;
  return (
    permission === "clipboard-sanitized-write" &&
    CLIPBOARD_EMBED_ORIGINS.has(originOf(embedUrl ?? ""))
  );
}

/**
 * Whether to grant a permission request (`setPermissionRequestHandler`).
 * `topUrl` is the requesting webContents' main-frame URL.
 */
function allowPermissionRequest({ permission, details, topUrl, isAppOrigin }) {
  const requestingUrl = details?.requestingUrl || topUrl || "";
  if (isAppOrigin(requestingUrl)) return APP_PERMISSIONS.has(permission);
  return (
    details?.isMainFrame === false &&
    isAppOrigin(topUrl ?? "") &&
    delegatedToEmbed(permission, requestingUrl)
  );
}

/** Synchronous counterpart for `setPermissionCheckHandler`. */
function allowPermissionCheck({ permission, requestingOrigin, details, isAppOrigin }) {
  if (isAppOrigin(requestingOrigin)) return APP_PERMISSIONS.has(permission);
  return (
    details?.isMainFrame === false &&
    isAppOrigin(details.embeddingOrigin ?? "") &&
    delegatedToEmbed(permission, requestingOrigin)
  );
}

module.exports = {
  APP_PERMISSIONS,
  CLIPBOARD_EMBED_ORIGINS,
  DELEGATED_PERMISSIONS,
  allowPermissionCheck,
  allowPermissionRequest,
};

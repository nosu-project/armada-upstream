"use strict";

/** Platform policy for Electron display capture. */
function displayMediaHandlerOptions(platform = process.platform) {
  // Electron uses this only when the trusted picker exists (macOS 15+); on
  // older macOS versions it invokes Armada's handler as the fallback.
  return { useSystemPicker: platform === "darwin" };
}

function displayMediaGrant(
  source,
  { platform = process.platform, audioRequested = false } = {},
) {
  return {
    video: source,
    // Electron's string loopback source is currently Windows-only.
    ...(platform === "win32" && audioRequested ? { audio: "loopback" } : {}),
  };
}

module.exports = { displayMediaGrant, displayMediaHandlerOptions };

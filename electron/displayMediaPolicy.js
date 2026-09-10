"use strict";

const os = require("node:os");

/** Platform policy for Electron display capture. */
function displayMediaHandlerOptions(platform = process.platform) {
  // Electron uses this only when the trusted picker exists (macOS 15+); on
  // older macOS versions it invokes Armada's handler as the fallback.
  return { useSystemPicker: platform === "darwin" };
}

// Windows system audio for a screen share is Chromium's WASAPI loopback, named
// by a device-id STRING the handler hands back. Electron documents two of them
// ("loopback", "loopbackWithMute") but passes any string through to Chromium
// unchanged, and Chromium has a third: "loopbackWithoutChrome", a per-process
// loopback (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, mode
// EXCLUDE_TARGET_PROCESS_TREE) that captures everything the OS is playing
// EXCEPT this app's own audio service — i.e. system audio minus the call.
// Plain "loopback" is the whole render mix, call included, which is why a
// sharer on Windows echoed every other participant back to them.
//
// This is how Vesktop fixed the same bug (Vencord/Vesktop#1294): grant the
// device directly from the main process. It does not depend on the renderer's
// `restrictOwnAudio` constraint reaching this handler (Electron only maps that
// to this device from 43.4.0, and only when Chromium populates the request),
// so it cannot silently degrade to the echoing mix the way the constraint
// path did.
//
// The floor is the OS: process loopback needs the Windows 10 2004 audio stack
// (build 19041 — OBS's Application Audio Capture has the same floor; Microsoft
// documents the header at 20348, but Vesktop users confirmed 19044 and 19045).
// Below it Chromium cannot activate the device and the whole capture would
// fail, so an older build gets plain "loopback": the renderer's own-audio gate
// refuses that track and the share goes out video-only with an explanation,
// rather than with the echo.
const PROCESS_LOOPBACK_MIN_WINDOWS_BUILD = 19041;
const PROCESS_EXCLUDED_LOOPBACK = "loopbackWithoutChrome";
const UNRESTRICTED_LOOPBACK = "loopback";

/** The build number from a Windows `os.release()` such as "10.0.19045". */
function windowsBuild(release) {
  const build = Number(String(release).split(".").pop());
  return Number.isFinite(build) ? build : 0;
}

function windowsShareAudioSource(release = os.release()) {
  return windowsBuild(release) >= PROCESS_LOOPBACK_MIN_WINDOWS_BUILD
    ? PROCESS_EXCLUDED_LOOPBACK
    : UNRESTRICTED_LOOPBACK;
}

function displayMediaGrant(
  source,
  { platform = process.platform, audioRequested = false, osRelease } = {},
) {
  // Linux audio is attached through venmic (main.js), and macOS 15+ owns its
  // audio selection in the trusted picker; only Windows grants a loopback.
  if (platform !== "win32" || !audioRequested) return { video: source };
  return { video: source, audio: windowsShareAudioSource(osRelease) };
}

module.exports = {
  PROCESS_LOOPBACK_MIN_WINDOWS_BUILD,
  displayMediaGrant,
  displayMediaHandlerOptions,
  windowsShareAudioSource,
};

"use strict";

// Launch-at-login for the desktop shell.
//
// Electron's `app.setLoginItemSettings` registers the app to start when the
// user logs in. It is native on Windows and macOS, and on Linux (Electron 29+)
// it writes a ~/.config/autostart/<name>.desktop entry. Elsewhere the API is a
// no-op, so this module reports `supported: false` and the renderer hides the
// control.
//
// "Start minimized" is carried differently per platform: macOS has a native
// `openAsHidden`, while Windows/Linux get the `--hidden` launch arg the shell
// already honours (see `startHidden` in main.js). To keep the read side one
// answer on every platform — Linux's autostart entry and Windows' registry
// value don't round-trip the arg reliably — the hidden intent is also mirrored
// into a small file under userData, the same way the video-encoder mode is.
// `openAtLogin` still comes from the OS, which is the truth for whether the
// entry actually exists (a user can delete it in their OS settings).

const fs = require("node:fs");
const path = require("node:path");

const OPEN_AS_HIDDEN_FILE = "launch-hidden";
const HIDDEN_ARG = "--hidden";

const SUPPORTED_PLATFORMS = new Set(["darwin", "win32", "linux"]);

function launchHiddenPath(userDataPath) {
  return path.join(userDataPath, OPEN_AS_HIDDEN_FILE);
}

function readOpenAsHidden(userDataPath, fsImpl) {
  if (!userDataPath) return false;
  try {
    return fsImpl.readFileSync(launchHiddenPath(userDataPath), "utf8").trim() === "1";
  } catch {
    return false;
  }
}

function writeOpenAsHidden(userDataPath, hidden, fsImpl) {
  if (!userDataPath) return;
  fsImpl.mkdirSync(userDataPath, { recursive: true });
  fsImpl.writeFileSync(launchHiddenPath(userDataPath), hidden ? "1\n" : "0\n", { mode: 0o600 });
}

// The file to relaunch. Under a Linux AppImage `process.execPath` is the
// binary extracted inside the transient mount, which is gone on the next
// login; $APPIMAGE is the stable file. Windows/macOS relaunch their own
// `execPath`, so let Electron default to it.
function launchPath(platform, env) {
  if (platform === "linux" && env && env.APPIMAGE) return env.APPIMAGE;
  return undefined;
}

function isSupported(platform, appImpl, method) {
  return (
    SUPPORTED_PLATFORMS.has(platform) &&
    Boolean(appImpl) &&
    typeof appImpl[method] === "function"
  );
}

function getLaunchSettings({
  platform = process.platform,
  appImpl,
  userDataPath,
  fsImpl = fs,
} = {}) {
  if (!isSupported(platform, appImpl, "getLoginItemSettings")) {
    return { supported: false, openAtLogin: false, openAsHidden: false };
  }
  let openAtLogin = false;
  try {
    openAtLogin = Boolean(appImpl.getLoginItemSettings().openAtLogin);
  } catch {
    openAtLogin = false;
  }
  return {
    supported: true,
    openAtLogin,
    openAsHidden: readOpenAsHidden(userDataPath, fsImpl),
  };
}

function setLaunchSettings(
  settings,
  {
    platform = process.platform,
    appImpl,
    userDataPath,
    fsImpl = fs,
    env = process.env,
  } = {},
) {
  if (!isSupported(platform, appImpl, "setLoginItemSettings")) {
    return { supported: false, openAtLogin: false, openAsHidden: false };
  }
  const openAtLogin = Boolean(settings && settings.openAtLogin);
  const openAsHidden = Boolean(settings && settings.openAsHidden);

  const options = { openAtLogin };
  const execPath = launchPath(platform, env);
  if (execPath) options.path = execPath;
  if (platform === "darwin") {
    options.openAsHidden = openAsHidden;
  } else {
    // Windows/Linux have no native openAsHidden; carry it as the launch arg the
    // shell already turns into a hidden-to-tray start.
    options.args = openAsHidden ? [HIDDEN_ARG] : [];
  }

  try {
    appImpl.setLoginItemSettings(options);
  } catch {
    // Report what the OS actually reflects below rather than throwing at the
    // renderer; a failed write leaves the toggle showing the real state.
  }
  writeOpenAsHidden(userDataPath, openAsHidden, fsImpl);

  return getLaunchSettings({ platform, appImpl, userDataPath, fsImpl });
}

module.exports = {
  HIDDEN_ARG,
  SUPPORTED_PLATFORMS,
  getLaunchSettings,
  setLaunchSettings,
};

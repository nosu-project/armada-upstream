"use strict";

/**
 * Decide whether this package format has a safe, writable self-update path.
 * Keep this independent of Electron so every release format can be tested on
 * the Linux CI runner that produces Armada's installers.
 */
function supportsSelfUpdate({
  isPackaged,
  platform,
  env = {},
  isMas = false,
  isWindowsStore = false,
  macUpdateDisabled = false,
}) {
  if (!isPackaged) return false;

  if (platform === "win32") {
    // Squirrel/NSIS installs have an update owner; portable and Store packages
    // do not. electron-builder supplies these PORTABLE_* variables itself.
    return (
      !isWindowsStore &&
      !env.PORTABLE_EXECUTABLE_FILE &&
      !env.PORTABLE_EXECUTABLE_DIR
    );
  }

  if (platform === "darwin") {
    return !isMas && !macUpdateDisabled;
  }

  if (platform === "linux") {
    // AppImage is the sole self-updating Linux edition. deb and Flatpak remain
    // owned by apt/the configured Flatpak remote and must never replace files
    // behind their package manager.
    return Boolean(env.APPIMAGE) && !env.FLATPAK_ID;
  }

  return false;
}

function hasDeveloperIdUpdateSignature(signatureDetails) {
  const details = String(signatureDetails || "");
  return (
    !details.includes("Signature=adhoc") &&
    /^Authority=Developer ID Application:/m.test(details)
  );
}

/**
 * Arm electron-updater after `supportsSelfUpdate()` has assigned ownership to
 * this package. An installed NSIS build follows the same policy whether or not
 * it carries Authenticode: signing adds an independent publisher identity, but
 * is not a prerequisite for a user-selected install to update itself.
 */
function configureAutoUpdater(autoUpdater) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
}

module.exports = {
  configureAutoUpdater,
  hasDeveloperIdUpdateSignature,
  supportsSelfUpdate,
};

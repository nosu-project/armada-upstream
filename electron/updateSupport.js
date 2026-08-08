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
 * Read a `Get-AuthenticodeSignature ... .Status` verdict. PowerShell's
 * SignatureStatus enum uses `Valid` for a trusted chain; everything else
 * (NotSigned, HashMismatch, UnknownError, NotTrusted) is a refusal.
 */
function hasTrustedWindowsSignature(status) {
  return String(status || "").trim() === "Valid";
}

/**
 * Whether an update may be downloaded and installed without asking.
 *
 * On Windows an unsigned NSIS build makes electron-updater's publisherName
 * check vacuous, so arming autoDownload + autoInstallOnAppQuit would let
 * anyone who can serve the update path run code on every user — TLS to the
 * host being the only thing in the way. Unsigned Windows builds still CHECK
 * for updates; they just tell the user rather than installing.
 *
 * The other platforms already carry their own gate: macOS self-update is
 * refused outright unless the bundle has a Developer ID signature
 * (`hasDeveloperIdUpdateSignature`), and an AppImage is replaced only after
 * electron-updater verifies the sha512 the feed declares.
 */
function autoInstallAllowed({ platform, signed = false }) {
  if (platform === "win32") return Boolean(signed);
  return true;
}

module.exports = {
  autoInstallAllowed,
  hasDeveloperIdUpdateSignature,
  hasTrustedWindowsSignature,
  supportsSelfUpdate,
};

import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  configureAutoUpdater,
  hasDeveloperIdUpdateSignature,
  supportsSelfUpdate,
} = require("./updateSupport.js");

const supported = (overrides) =>
  supportsSelfUpdate({
    isPackaged: true,
    platform: "win32",
    env: {},
    ...overrides,
  });

describe("desktop self-update ownership", () => {
  it("assigns installed Windows NSIS builds an update owner", () => {
    expect(supported({ platform: "win32" })).toBe(true);
  });

  it("leaves Windows portable and Store builds externally managed", () => {
    expect(
      supported({
        platform: "win32",
        env: { PORTABLE_EXECUTABLE_FILE: "Armada.exe" },
      }),
    ).toBe(false);
    expect(
      supported({
        platform: "win32",
        env: { PORTABLE_EXECUTABLE_DIR: "C:\\Armada" },
      }),
    ).toBe(false);
    expect(supported({ platform: "win32", isWindowsStore: true })).toBe(false);
  });

  it("enables normal macOS builds but not MAS or cross-built archives", () => {
    expect(supported({ platform: "darwin" })).toBe(true);
    expect(supported({ platform: "darwin", isMas: true })).toBe(false);
    expect(supported({ platform: "darwin", macUpdateDisabled: true })).toBe(false);
  });

  it("enables only AppImage on Linux", () => {
    expect(supported({ platform: "linux", env: { APPIMAGE: "/opt/Armada.AppImage" } })).toBe(true);
    expect(
      supported({
        platform: "linux",
        env: { APPIMAGE: "/opt/Armada.AppImage", FLATPAK_ID: "buzz.armada.app" },
      }),
    ).toBe(false);
    expect(supported({ platform: "linux", env: {} })).toBe(false);
  });

  it("never updates unpackaged or unknown builds", () => {
    expect(supported({ isPackaged: false })).toBe(false);
    expect(supported({ platform: "freebsd" })).toBe(false);
  });

  it("distinguishes Developer ID signatures from ad-hoc macOS signatures", () => {
    expect(
      hasDeveloperIdUpdateSignature(
        "Authority=Developer ID Application: Armada LLC (ABCDE12345)\nTeamIdentifier=ABCDE12345",
      ),
    ).toBe(true);
    expect(hasDeveloperIdUpdateSignature("Signature=adhoc\nTeamIdentifier=not set")).toBe(false);
    expect(hasDeveloperIdUpdateSignature("")).toBe(false);
  });
});

describe("automatic update policy", () => {
  it("downloads and installs supported packages without a signing prerequisite", () => {
    const updater = {};
    configureAutoUpdater(updater);
    expect(updater).toEqual({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowDowngrade: false,
    });
  });
});

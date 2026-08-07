// @vitest-environment node

import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { Variant } = require("@jellybrick/dbus-next");
const {
  ALTERNATE_SHORTCUT_ID,
  LinuxGlobalShortcutsPortal,
  bindingToXdgTrigger,
  desktopEnvironment,
  formatShortcutDescription,
  knownShortcutId,
  nextLegacyShortcutId,
  portalSettingsHint,
  readPortalVersion,
  shortcutDescription,
  xdgKeyName,
} = require("./linuxGlobalShortcuts.js");

describe("Linux Global Shortcuts portal binding", () => {
  it("converts physical keys and modifiers to XDG shortcut identifiers", () => {
    expect(xdgKeyName("CapsLock")).toBe("Caps_Lock");
    expect(xdgKeyName("KeyQ")).toBe("q");
    expect(bindingToXdgTrigger({
      code: "Space",
      label: "Ctrl + Shift + Space",
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    })).toBe("CTRL+SHIFT+space");
  });

  it("uses the compositor's assigned shortcut description", () => {
    const shortcuts = [["push_to_talk", {
      trigger_description: new Variant("s", "Ctrl+F12"),
    }]];
    expect(shortcutDescription(shortcuts, "Caps Lock")).toBe("Ctrl+F12");
    expect(shortcutDescription([[ALTERNATE_SHORTCUT_ID, new Map([
      ["trigger_description", new Variant("s", "Ctrl + Press d")],
    ])]], "Caps Lock", ALTERNATE_SHORTCUT_ID)).toBe("Ctrl + D");
    expect(shortcutDescription([], "Caps Lock")).toBe("Caps Lock");
  });

  it("renders GNOME accelerator descriptions as user-facing labels", () => {
    expect(formatShortcutDescription("<Control>x")).toBe("Ctrl + X");
    expect(formatShortcutDescription("<Shift><Alt>F12")).toBe("Shift + Alt + F12");
    expect(formatShortcutDescription("Ctrl + Press x")).toBe("Ctrl + X");
    expect(formatShortcutDescription("Caps Lock")).toBe("Caps Lock");
  });

  it("detects GNOME, KDE, and COSMIC desktop sessions", () => {
    expect(desktopEnvironment({ XDG_CURRENT_DESKTOP: "GNOME" })).toBe("gnome");
    expect(desktopEnvironment({ XDG_CURRENT_DESKTOP: "KDE" })).toBe("kde");
    expect(desktopEnvironment({ XDG_CURRENT_DESKTOP: "COSMIC" })).toBe("cosmic");
  });

  it("uses the portal version to advertise the trusted shortcut editor", async () => {
    const get = vi.fn(async () => new Variant("u", 2));
    await expect(readPortalVersion({
      getInterface: () => ({ Get: get }),
    })).resolves.toBe(2);
    expect(get).toHaveBeenCalledWith("org.freedesktop.portal.GlobalShortcuts", "version");
    expect(portalSettingsHint("kde", 2)).toContain("trusted editor");
    expect(portalSettingsHint("gnome", 1)).toContain("trusted shortcut chooser");
  });

  it("recognizes and alternates the two persisted legacy action IDs", () => {
    expect(knownShortcutId(ALTERNATE_SHORTCUT_ID)).toBe(ALTERNATE_SHORTCUT_ID);
    expect(knownShortcutId("unknown")).toBe("push_to_talk");
    expect(nextLegacyShortcutId("push_to_talk")).toBe(ALTERNATE_SHORTCUT_ID);
    expect(nextLegacyShortcutId(ALTERNATE_SHORTCUT_ID)).toBe("push_to_talk");
  });

  it("uses ConfigureShortcuts for a version-2 portal", async () => {
    const configure = vi.fn(async () => {});
    const portal = new LinuxGlobalShortcutsPortal({ env: { XDG_CURRENT_DESKTOP: "KDE" } });
    portal.globalShortcuts = { ConfigureShortcuts: configure };
    portal.sessionHandle = "/org/freedesktop/portal/desktop/session/test";
    portal.portalVersion = 2;
    await expect(portal.openSettings()).resolves.toBe(true);
    expect(configure).toHaveBeenCalledWith(portal.sessionHandle, "", {});
  });

  it("reopens BindShortcuts with a replacement action on a version-1 portal", async () => {
    const reportStatus = vi.fn();
    const saveShortcutId = vi.fn();
    const portal = new LinuxGlobalShortcutsPortal({
      env: { XDG_CURRENT_DESKTOP: "GNOME" },
      saveShortcutId,
    });
    portal.bus = {};
    portal.globalShortcuts = {};
    portal.sessionHandle = "/org/freedesktop/portal/desktop/session/old";
    portal.shortcutId = "push_to_talk";
    portal.binding = { label: "Caps Lock" };
    portal.onStatusChanged = reportStatus;
    portal.portalVersion = 1;
    portal.createSession = vi.fn(async () => "/org/freedesktop/portal/desktop/session/new");
    portal.bindSession = vi.fn(async () => ({
      shortcuts: [[ALTERNATE_SHORTCUT_ID, {
        trigger_description: new Variant("s", "Ctrl + Press d"),
      }]],
    }));
    portal.closeSession = vi.fn(async () => {});

    await expect(portal.openSettings()).resolves.toBe(true);
    expect(portal.bindSession).toHaveBeenCalledWith(
      "/org/freedesktop/portal/desktop/session/new",
      ALTERNATE_SHORTCUT_ID,
      null,
      expect.stringContaining("armada_ptt_"),
    );
    expect(portal.closeSession).toHaveBeenCalledWith(
      "/org/freedesktop/portal/desktop/session/old",
    );
    expect(portal.sessionHandle).toContain("/new");
    expect(portal.shortcutId).toBe(ALTERNATE_SHORTCUT_ID);
    expect(saveShortcutId).toHaveBeenCalledWith(ALTERNATE_SHORTCUT_ID);
    expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({
      bindingLabel: "Ctrl + D",
      settingsAvailable: true,
    }));
  });

  it("keeps the active version-1 shortcut when the replacement chooser is cancelled", async () => {
    const portal = new LinuxGlobalShortcutsPortal({ env: { XDG_CURRENT_DESKTOP: "GNOME" } });
    const oldSession = "/org/freedesktop/portal/desktop/session/old";
    const newSession = "/org/freedesktop/portal/desktop/session/new";
    portal.bus = {};
    portal.globalShortcuts = {};
    portal.sessionHandle = oldSession;
    portal.shortcutId = "push_to_talk";
    portal.binding = { label: "Caps Lock" };
    portal.portalVersion = 1;
    portal.createSession = vi.fn(async () => newSession);
    portal.bindSession = vi.fn(async () => {
      throw new Error("Global shortcut setup was cancelled");
    });
    portal.closeSession = vi.fn(async () => {});

    await expect(portal.openSettings()).resolves.toBe(true);
    expect(portal.sessionHandle).toBe(oldSession);
    expect(portal.shortcutId).toBe("push_to_talk");
    expect(portal.closeSession).toHaveBeenCalledWith(newSession);
    expect(portal.closeSession).not.toHaveBeenCalledWith(oldSession);
    expect(portal.suspended).toBe(false);
  });
});

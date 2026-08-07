// @vitest-environment node

import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { Variant } = require("@jellybrick/dbus-next");
const {
  LinuxGlobalShortcutsPortal,
  bindingToXdgTrigger,
  desktopEnvironment,
  formatShortcutDescription,
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
    expect(portalSettingsHint("gnome", 1)).toContain("Settings → Apps → Armada");
  });

  it("only invokes ConfigureShortcuts for a version-2 portal", async () => {
    const configure = vi.fn(async () => {});
    const portal = new LinuxGlobalShortcutsPortal({ env: { XDG_CURRENT_DESKTOP: "KDE" } });
    portal.globalShortcuts = { ConfigureShortcuts: configure };
    portal.sessionHandle = "/org/freedesktop/portal/desktop/session/test";
    portal.portalVersion = 1;
    await expect(portal.openSettings()).resolves.toBe(false);
    expect(configure).not.toHaveBeenCalled();

    portal.portalVersion = 2;
    await expect(portal.openSettings()).resolves.toBe(true);
    expect(configure).toHaveBeenCalledWith(portal.sessionHandle, "", {});
  });
});

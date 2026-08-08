// @vitest-environment node

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { Variant } = require("@jellybrick/dbus-next");
const {
  ALTERNATE_SHORTCUT_ID,
  GLOBAL_SHORTCUTS_INTERFACE,
  LinuxGlobalShortcutsPortal,
  SHORTCUT_ID,
  bindingToXdgTrigger,
  desktopEnvironment,
  formatShortcutDescription,
  knownShortcutId,
  nextLegacyShortcutId,
  portalRequest,
  portalSettingsHint,
  readPortalVersion,
  shortcutDescription,
  xdgKeyName,
} = require("./linuxGlobalShortcuts.js");

const SESSION_A = "/org/freedesktop/portal/desktop/session/a";
const SESSION_B = "/org/freedesktop/portal/desktop/session/b";
const BINDING = { code: "CapsLock", label: "Caps Lock" };

/**
 * Start a portal against a fake session bus so the REAL Activated/Deactivated
 * handlers get installed. Stubbing those out is what let the suspend-window bug
 * through: the guard they consult is the whole subject of these tests.
 */
async function startPortal({ portalVersion = 1 } = {}) {
  const shortcuts = new EventEmitter();
  const bus = {
    getProxyObject: async () => ({
      getInterface: (name) => (
        name === GLOBAL_SHORTCUTS_INTERFACE
          ? shortcuts
          : { Get: async () => new Variant("u", portalVersion) }
      ),
    }),
    disconnect: () => {},
  };
  const portal = new LinuxGlobalShortcutsPortal({
    sessionBus: () => bus,
    env: { XDG_CURRENT_DESKTOP: "GNOME" },
  });
  portal.createSession = vi.fn(async () => SESSION_A);
  portal.bindSession = vi.fn(async () => ({
    shortcuts: [[SHORTCUT_ID, { trigger_description: new Variant("s", "Caps Lock") }]],
  }));
  portal.closeSession = vi.fn(async () => {});

  const pressed = [];
  await portal.start(BINDING, (value) => pressed.push(value));
  pressed.length = 0;
  return { portal, shortcuts, pressed };
}

/**
 * Echo back whichever action ID openSettings minted. Hardcoding one here would
 * pin the test to a particular ID scheme rather than to the behaviour.
 */
function replacementBind() {
  return vi.fn(async (_session, shortcutId) => ({
    shortcuts: [[shortcutId, {
      trigger_description: new Variant("s", "Ctrl + Press d"),
    }]],
  }));
}

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

  it("recognizes persisted legacy action IDs", () => {
    expect(knownShortcutId(ALTERNATE_SHORTCUT_ID)).toBe(ALTERNATE_SHORTCUT_ID);
    expect(knownShortcutId("push_to_talk_4")).toBe("push_to_talk_4");
    expect(knownShortcutId("unknown")).toBe("push_to_talk");
    expect(knownShortcutId(undefined)).toBe("push_to_talk");
  });

  it("never reuses an action ID the portal has already bound", () => {
    // BindShortcuts only shows the trusted chooser for an action the portal has
    // no binding for, and bindings are keyed by (app id, shortcut id) and
    // outlive the session. Alternating between two IDs therefore stops
    // prompting on the second "change shortcut": the user sees no dialog and
    // their key silently reverts to the older assignment.
    let shortcutId = "push_to_talk";
    const seen = new Set([shortcutId]);
    for (let round = 0; round < 6; round += 1) {
      shortcutId = nextLegacyShortcutId(shortcutId);
      expect(seen.has(shortcutId)).toBe(false);
      expect(knownShortcutId(shortcutId)).toBe(shortcutId);
      seen.add(shortcutId);
    }
    // A value persisted by an older build still advances into the counted
    // series rather than sticking on itself.
    expect(nextLegacyShortcutId(ALTERNATE_SHORTCUT_ID)).toMatch(/^push_to_talk_\d+$/);
    expect(nextLegacyShortcutId(ALTERNATE_SHORTCUT_ID)).not.toBe(ALTERNATE_SHORTCUT_ID);
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
    portal.bindSession = replacementBind();
    portal.closeSession = vi.fn(async () => {});

    const replacementId = nextLegacyShortcutId("push_to_talk");
    await expect(portal.openSettings()).resolves.toBe(true);
    expect(portal.bindSession).toHaveBeenCalledWith(
      "/org/freedesktop/portal/desktop/session/new",
      replacementId,
      null,
      expect.stringContaining("armada_ptt_"),
    );
    expect(portal.closeSession).toHaveBeenCalledWith(
      "/org/freedesktop/portal/desktop/session/old",
    );
    expect(portal.sessionHandle).toContain("/new");
    expect(portal.shortcutId).toBe(replacementId);
    expect(saveShortcutId).toHaveBeenCalledWith(replacementId);
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

  it("ignores a portal Response forged by another peer on the session bus", async () => {
    const bus = new EventEmitter();
    bus.call = vi.fn(async () => {});
    const requestPath = "/org/freedesktop/portal/desktop/request/1/armada_ptt_1";

    const settled = portalRequest(
      bus,
      async () => requestPath,
      { sender: ":1.7" },
    );
    // The listener is installed after AddMatch resolves; emitting before that
    // would drop the message and pass this test for the wrong reason.
    await vi.waitFor(() => expect(bus.listenerCount("message")).toBe(1));
    await Promise.resolve();

    // Request object paths are derived from the pid and a counter, so another
    // application on the bus can guess one and unicast a Response straight at
    // this connection. The AddMatch sender= clause only filters what the BUS
    // broadcasts; it does not authenticate a directed message.
    bus.emit("message", {
      interface: "org.freedesktop.portal.Request",
      member: "Response",
      path: requestPath,
      sender: ":1.99",
      body: [0, { forged: true }],
    });
    await Promise.resolve();

    let resolved = false;
    void settled.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    bus.emit("message", {
      interface: "org.freedesktop.portal.Request",
      member: "Response",
      path: requestPath,
      sender: ":1.7",
      body: [0, { shortcuts: [] }],
    });

    await expect(settled).resolves.toEqual({ shortcuts: [] });
  });

  it("stays muted when a press lands while the replacement chooser is opening", async () => {
    const { portal, shortcuts, pressed } = await startPortal();

    // The old session stays live until the user accepts, so the compositor
    // keeps delivering its signals throughout. Anything awaited before the
    // suspend guard is armed is a window in which Activated is honoured but
    // the matching Deactivated is not.
    portal.createSession = vi.fn(async () => {
      shortcuts.emit("Activated", SESSION_A, SHORTCUT_ID);
      return SESSION_B;
    });
    portal.bindSession = replacementBind();

    await expect(portal.openSettings()).resolves.toBe(true);

    expect(pressed).not.toContain(true);
    expect(pressed.at(-1)).toBe(false);
  });

  it("releases a held key whose Deactivated is swallowed by the chooser", async () => {
    const { portal, shortcuts, pressed } = await startPortal();

    shortcuts.emit("Activated", SESSION_A, SHORTCUT_ID);
    expect(pressed).toEqual([true]);

    portal.createSession = vi.fn(async () => SESSION_B);
    portal.bindSession = vi.fn(async (_session, shortcutId) => {
      // The user let go while the trusted chooser had the keyboard grabbed.
      shortcuts.emit("Deactivated", SESSION_A, SHORTCUT_ID);
      return {
        shortcuts: [[shortcutId, {
          trigger_description: new Variant("s", "Ctrl + Press d"),
        }]],
      };
    });

    await expect(portal.openSettings()).resolves.toBe(true);

    expect(pressed.at(-1)).toBe(false);
  });

  it("resumes closed when the replacement session cannot be created", async () => {
    const { portal, shortcuts, pressed } = await startPortal();

    portal.createSession = vi.fn(async () => {
      shortcuts.emit("Activated", SESSION_A, SHORTCUT_ID);
      throw new Error("Global shortcut portal returned no session");
    });

    await expect(portal.openSettings()).rejects.toThrow(/no session/);

    expect(portal.suspended).toBe(false);
    expect(pressed.at(-1)).toBe(false);
  });
});

import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  canUseLinuxTray,
  detectLinuxTrayEnvironment,
  detectLinuxTraySupport,
  legacyX11TrayLikelyAvailable,
  parseStatusNotifierItems,
  queryStatusNotifierItems,
  statusNotifierWatcherOwned,
} = require("./traySupport.js");

describe("Linux tray support", () => {
  it("parses gdbus NameHasOwner tuples", () => {
    expect(statusNotifierWatcherOwned("(true,)\n")).toBe(true);
    expect(statusNotifierWatcherOwned("(false,)\n")).toBe(false);
    expect(statusNotifierWatcherOwned("")).toBe(false);
  });

  it("parses the watcher's registered StatusNotifier items", () => {
    expect(
      parseStatusNotifierItems(
        "(<[':1.98@/StatusNotifierItem', 'org.example.Item-2-1']>,)\n",
      ),
    ).toEqual([":1.98@/StatusNotifierItem", "org.example.Item-2-1"]);
  });

  it("uses StatusNotifierItem whenever a watcher is present", () => {
    expect(
      canUseLinuxTray({
        watcherOwned: true,
        env: {
          XDG_CURRENT_DESKTOP: "GNOME",
          XDG_SESSION_TYPE: "wayland",
          WAYLAND_DISPLAY: "wayland-0",
        },
      }),
    ).toBe(true);
  });

  it("does not assume Wayland or GNOME has a visible legacy tray", () => {
    expect(
      legacyX11TrayLikelyAvailable({
        XDG_CURRENT_DESKTOP: "sway",
        XDG_SESSION_TYPE: "wayland",
        WAYLAND_DISPLAY: "wayland-1",
        DISPLAY: ":0",
      }),
    ).toBe(false);
    expect(
      legacyX11TrayLikelyAvailable({
        XDG_CURRENT_DESKTOP: "GNOME",
        XDG_SESSION_TYPE: "x11",
        DISPLAY: ":0",
      }),
    ).toBe(false);
  });

  it("allows Electron's GtkStatusIcon fallback on non-GNOME X11 desktops", () => {
    expect(
      legacyX11TrayLikelyAvailable({
        XDG_CURRENT_DESKTOP: "XFCE",
        XDG_SESSION_TYPE: "x11",
        DISPLAY: ":0",
      }),
    ).toBe(true);
  });

  it("falls back safely when gdbus is absent or the watcher is unowned", async () => {
    const execFileImpl = vi.fn((_file, _args, _options, callback) => {
      callback(new Error("not found"), "");
    });

    await expect(
      detectLinuxTraySupport({
        env: {
          XDG_CURRENT_DESKTOP: "GNOME",
          XDG_SESSION_TYPE: "wayland",
          WAYLAND_DISPLAY: "wayland-0",
        },
        execFileImpl,
      }),
    ).resolves.toBe(false);
  });

  it("detects a live watcher through the session bus", async () => {
    const execFileImpl = vi
      .fn()
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, "(true,)\n");
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, "(<[':1.20@/StatusNotifierItem']>,)\n");
      });

    await expect(
      detectLinuxTraySupport({
        env: {
          XDG_CURRENT_DESKTOP: "GNOME",
          XDG_SESSION_TYPE: "wayland",
        },
        execFileImpl,
      }),
    ).resolves.toBe(true);
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });

  it("reports whether support came from StatusNotifier or the X11 fallback", async () => {
    const execFileImpl = vi
      .fn()
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, "(true,)\n");
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, "(<[':1.20@/StatusNotifierItem']>,)\n");
      });

    await expect(
      detectLinuxTrayEnvironment({
        env: { XDG_CURRENT_DESKTOP: "GNOME", XDG_SESSION_TYPE: "wayland" },
        execFileImpl,
      }),
    ).resolves.toEqual({
      registeredItems: [":1.20@/StatusNotifierItem"],
      watcherOwned: true,
      supported: true,
    });
  });

  it("returns null when the watcher item list cannot be read", async () => {
    const execFileImpl = vi.fn((_file, _args, _options, callback) => {
      callback(new Error("filtered"), "");
    });

    await expect(queryStatusNotifierItems(execFileImpl)).resolves.toBeNull();
  });
});

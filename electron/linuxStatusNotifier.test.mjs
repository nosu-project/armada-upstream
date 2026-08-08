import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  ArmadaStatusNotifierItem,
  ArmadaDbusMenu,
  MENU_PATH,
  SERVICE_NAME,
  nativeImageToArgbPixmaps,
  watchStatusNotifierWatcher,
} = require("./linuxStatusNotifier.js");

describe("Linux StatusNotifierItem", () => {
  it("uses a Flatpak-owned application subname", () => {
    expect(SERVICE_NAME).toBe("buzz.armada.app.StatusNotifierItem");
  });

  it("exposes the configured SNI contract on each service instance", () => {
    const item = new ArmadaStatusNotifierItem({
      iconPixmaps: [],
      tooltip: "Armada",
    });

    expect(Object.keys(item.$properties)).toContain("IconPixmap");
    expect(Object.keys(item.$properties)).toContain("ToolTip");
    expect(Object.keys(item.$methods)).toContain("Activate");
    expect(Object.keys(item.$methods)).toContain("ContextMenu");
    expect(item.Menu).toBe(MENU_PATH);
  });

  it("exports a DBusMenu layout that GNOME AppIndicator can consume", () => {
    const menu = new ArmadaDbusMenu(() => [
      { id: 1, label: "Show Armada", activate: vi.fn() },
      { id: 2, type: "separator" },
      { id: 3, label: "Quit", activate: vi.fn() },
    ]);

    const [revision, layout] = menu.GetLayout(0, -1, []);
    expect(revision).toBe(1);
    expect(layout[0]).toBe(0);
    expect(layout[2]).toHaveLength(3);
    expect(layout[2][0].value[1].label.value).toBe("Show Armada");
    expect(layout[2][1].value[1].type.value).toBe("separator");
    expect(Object.keys(menu.$methods)).toContain("Event");
  });

  it("dispatches DBusMenu click events to the matching command", async () => {
    const activate = vi.fn();
    const menu = new ArmadaDbusMenu(() => [
      { id: 4, label: "Quit", activate },
    ]);

    menu.Event(4, "clicked");
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(activate).toHaveBeenCalledOnce();
  });

  it("re-registers the item when the StatusNotifierWatcher restarts", async () => {
    const bus = new EventEmitter();
    bus.call = vi.fn(async () => {});
    const register = vi.fn(async () => {});

    const stop = watchStatusNotifierWatcher(bus, register);
    await vi.waitFor(() => expect(bus.call).toHaveBeenCalled());

    const ownerChanged = (name, oldOwner, newOwner) => bus.emit("message", {
      interface: "org.freedesktop.DBus",
      member: "NameOwnerChanged",
      body: [name, oldOwner, newOwner],
    });

    // plasmashell or the GNOME AppIndicator extension restarting is routine,
    // and the item registered with the previous instance is simply gone.
    ownerChanged("org.kde.StatusNotifierWatcher", ":1.4", "");
    expect(register).not.toHaveBeenCalled();

    ownerChanged("org.kde.StatusNotifierWatcher", "", ":1.9");
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());

    // Another service cycling on the bus is not our business.
    ownerChanged("org.example.Unrelated", "", ":1.10");
    expect(register).toHaveBeenCalledOnce();

    stop();
    ownerChanged("org.kde.StatusNotifierWatcher", "", ":1.11");
    expect(register).toHaveBeenCalledOnce();
  });

  it("converts Electron BGRA pixels to SNI network-order ARGB", () => {
    const image = {
      resize: () => ({
        getSize: () => ({ width: 2, height: 1 }),
        toBitmap: () => Buffer.from([
          10, 20, 30, 255,
          40, 50, 60, 128,
        ]),
      }),
    };

    const [[width, height, pixels]] = nativeImageToArgbPixmaps(image, [2]);
    expect({ width, height }).toEqual({ width: 2, height: 1 });
    expect([...pixels]).toEqual([
      255, 30, 20, 10,
      128, 60, 50, 40,
    ]);
  });
});

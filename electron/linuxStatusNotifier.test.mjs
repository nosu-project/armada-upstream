import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  ArmadaStatusNotifierItem,
  ArmadaDbusMenu,
  MENU_PATH,
  SERVICE_NAME,
  nativeImageToArgbPixmaps,
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

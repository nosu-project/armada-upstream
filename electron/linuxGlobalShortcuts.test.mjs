// @vitest-environment node

import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { Variant } = require("@jellybrick/dbus-next");
const { bindingToXdgTrigger, shortcutDescription, xdgKeyName } = require("./linuxGlobalShortcuts.js");

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
});

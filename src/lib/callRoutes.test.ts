import { describe, expect, it } from "vitest";

import { routeLabel, type CallRoute } from "./callRoutes";

const route = (type: CallRoute["type"], name = ""): CallRoute => ({ id: 1, type, name });

describe("routeLabel", () => {
  it("names the phone's own transducers by kind", () => {
    expect(routeLabel(route("speaker"))).toBe("Speaker");
    expect(routeLabel(route("earpiece"))).toBe("Phone earpiece");
    expect(routeLabel(route("wired", "Pixel 8a"))).toBe("Wired headset");
  });

  it("uses an external device's product name, falling back to its kind", () => {
    expect(routeLabel(route("bluetooth", "Pixel Buds Pro"))).toBe("Pixel Buds Pro");
    expect(routeLabel(route("bluetooth", "  "))).toBe("Bluetooth");
    expect(routeLabel(route("usb", "Scarlett 2i2"))).toBe("Scarlett 2i2");
    expect(routeLabel(route("usb"))).toBe("USB audio");
  });
});

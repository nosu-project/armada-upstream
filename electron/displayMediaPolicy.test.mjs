import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { displayMediaGrant, displayMediaHandlerOptions } = require("./displayMediaPolicy.js");

describe("desktop display capture policy", () => {
  it("uses Apple's trusted system picker on macOS", () => {
    expect(displayMediaHandlerOptions("darwin")).toEqual({ useSystemPicker: true });
  });

  it("keeps Armada's picker on Windows and Linux", () => {
    expect(displayMediaHandlerOptions("win32")).toEqual({ useSystemPicker: false });
    expect(displayMediaHandlerOptions("linux")).toEqual({ useSystemPicker: false });
  });

  it("grants Windows loopback audio only when requested", () => {
    const source = { id: "screen:1" };
    expect(displayMediaGrant(source, { platform: "win32", audioRequested: true }))
      .toEqual({ video: source, audio: "loopback" });
    expect(displayMediaGrant(source, { platform: "win32", audioRequested: false }))
      .toEqual({ video: source });
  });

  it("never sends Electron's Windows-only loopback source on macOS or Linux", () => {
    const source = { id: "screen:1" };
    expect(displayMediaGrant(source, { platform: "darwin", audioRequested: true }))
      .toEqual({ video: source });
    expect(displayMediaGrant(source, { platform: "linux", audioRequested: true }))
      .toEqual({ video: source });
  });
});

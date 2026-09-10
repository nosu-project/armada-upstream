import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  PROCESS_LOOPBACK_MIN_WINDOWS_BUILD,
  displayMediaGrant,
  displayMediaHandlerOptions,
  windowsShareAudioSource,
} = require("./displayMediaPolicy.js");

describe("desktop display capture policy", () => {
  it("uses Apple's trusted system picker on macOS", () => {
    expect(displayMediaHandlerOptions("darwin")).toEqual({ useSystemPicker: true });
  });

  it("keeps Armada's picker on Windows and Linux", () => {
    expect(displayMediaHandlerOptions("win32")).toEqual({ useSystemPicker: false });
    expect(displayMediaHandlerOptions("linux")).toEqual({ useSystemPicker: false });
  });

  it("grants Windows system audio MINUS this app, so the call is never in the share", () => {
    // Plain "loopback" is the whole render mix, other participants' voices
    // included — the echo. "loopbackWithoutChrome" is Chromium's per-process
    // loopback excluding our own audio service (Vencord/Vesktop#1294).
    const source = { id: "screen:1" };
    const grant = displayMediaGrant(source, {
      platform: "win32",
      audioRequested: true,
      osRelease: "10.0.19045",
    });
    expect(grant).toEqual({ video: source, audio: "loopbackWithoutChrome" });
    expect(grant.audio).not.toBe("loopback");
  });

  it("grants the same process-excluded loopback for a window as for a screen", () => {
    // Every Windows surface is the same loopback device; there is no
    // per-window audio on this path, so a window share must not regress to
    // the mix either.
    expect(
      displayMediaGrant({ id: "window:42:0" }, {
        platform: "win32",
        audioRequested: true,
        osRelease: "10.0.22631",
      }).audio,
    ).toBe("loopbackWithoutChrome");
  });

  it("grants no audio on Windows unless it was requested", () => {
    const source = { id: "screen:1" };
    expect(displayMediaGrant(source, { platform: "win32", audioRequested: false, osRelease: "10.0.19045" }))
      .toEqual({ video: source });
  });

  it("falls back to plain loopback below the Windows 10 2004 audio stack", () => {
    // Process loopback cannot be activated there, which would fail the whole
    // capture. The renderer's own-audio gate refuses this device, so the share
    // goes out video-only with an explanation rather than with the echo.
    expect(PROCESS_LOOPBACK_MIN_WINDOWS_BUILD).toBe(19041);
    expect(windowsShareAudioSource("10.0.19041")).toBe("loopbackWithoutChrome");
    expect(windowsShareAudioSource("10.0.19044")).toBe("loopbackWithoutChrome");
    expect(windowsShareAudioSource("10.0.18363")).toBe("loopback");
    expect(windowsShareAudioSource("6.1.7601")).toBe("loopback");
    expect(windowsShareAudioSource("garbage")).toBe("loopback");
  });

  it("never sends a Windows loopback source on macOS or Linux", () => {
    const source = { id: "screen:1" };
    expect(displayMediaGrant(source, { platform: "darwin", audioRequested: true }))
      .toEqual({ video: source });
    expect(displayMediaGrant(source, { platform: "linux", audioRequested: true }))
      .toEqual({ video: source });
  });
});

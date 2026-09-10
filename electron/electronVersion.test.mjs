import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

// The desktop echo fix — excluding the app's own playback from the Windows
// screen-share audio loopback — is not something this repo can implement. The
// renderer's getDisplayMedia is served by the main process's
// setDisplayMediaRequestHandler, which grants system audio as a native
// "loopback" source (displayMediaPolicy.js). Electron only swaps that for the
// own-audio-excluding "loopbackWithoutChrome" when the renderer sets
// restrictOwnAudio on the audio track, and that mapping first shipped in
// Electron 43.4.0 (electron/electron#52455; issue #52427, backport #52533).
//
// Below 43.4.0 the flag reaches getDisplayMedia and is silently dropped by the
// handler, so a Windows sharer on speakers still echoes every participant back
// no matter how the renderer spells the constraint. This asserts the version we
// actually ship — the lockfile-resolved one electron-builder bundles — clears
// that floor. 43.3.0 (one day before the backport merged) is exactly what this
// catches.
const MINIMUM = [43, 4, 0];

function parseVersion(version) {
  return version
    .replace(/^[^\d]*/, "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));
}

function isAtLeast(actual, minimum) {
  for (let i = 0; i < 3; i++) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

describe("bundled Electron", () => {
  it("is new enough to honor restrictOwnAudio on Windows loopback (>= 43.4.0)", () => {
    const lock = require("./package-lock.json");
    const version = lock.packages?.["node_modules/electron"]?.version;
    expect(version, "electron is missing from electron/package-lock.json").toBeTruthy();

    expect(
      isAtLeast(parseVersion(version), MINIMUM),
      `Electron ${version} predates the restrictOwnAudio loopback fix; ` +
        "a Windows screen share on speakers will echo the call back. Need >= 43.4.0.",
    ).toBe(true);
  });
});

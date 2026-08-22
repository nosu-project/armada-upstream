import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { NostrReleaseProvider, updateInfoFrom } = require("./nostrUpdateProvider.js");

const BLOSSOM = `https://blossom.example/${"a".repeat(64)}`;

function update({ file, ...overrides } = {}) {
  return {
    version: "1.2.3",
    tag: "v1.2.3",
    releaseName: "Armada v1.2.3",
    releaseNotes: "notes",
    releaseDate: "2026-01-01T00:00:00.000Z",
    channel: "main",
    ...overrides,
    file: {
      url: BLOSSOM,
      filename: "Armada-v1.2.3.AppImage",
      sha256: "a".repeat(64),
      size: 1024,
      ...file,
    },
  };
}

describe("updateInfoFrom", () => {
  it("verifies against the sha256 content address, as sha2", () => {
    // electron-updater runs a `sha2` value through a sha256 digest. No sha512
    // anywhere: sha256 is what the event publishes and what the URL commits to.
    const info = updateInfoFrom(update());
    expect(info.version).toBe("1.2.3");
    expect(info.files).toEqual([
      { url: "Armada-v1.2.3.AppImage", size: 1024, sha2: "a".repeat(64) },
    ]);
    expect(info.files[0].sha512).toBeUndefined();
    expect(info.sha512).toBeUndefined();
  });

  it("refuses to build an update with no checksum at all", () => {
    // Our resolveFiles bypasses electron-updater's own ERR_UPDATER_NO_CHECKSUM
    // guard, so this is the only thing standing between a digest-less artifact
    // and an unverified download.
    expect(() => updateInfoFrom(update({ file: { sha256: "" } }))).toThrow(/no checksum/);
  });

  it("names the file by its FILENAME, never by the content-addressed URL", () => {
    // This is what electron-updater caches and, on Linux, installs the file
    // as. A hash here renames the user's AppImage to a hash.
    const info = updateInfoFrom(update());
    expect(info.files[0].url).toBe("Armada-v1.2.3.AppImage");
    expect(info.path).toBe("Armada-v1.2.3.AppImage");
    expect(JSON.stringify(info)).not.toContain("blossom.example");
  });

  it("carries the release notes electron-updater shows", () => {
    const info = updateInfoFrom(update());
    expect(info.releaseName).toBe("Armada v1.2.3");
    expect(info.releaseNotes).toBe("notes");
    expect(info.releaseDate).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("NostrReleaseProvider", () => {
  /** The provider without running its base constructor's runtime wiring. */
  function provider() {
    const instance = Object.create(NostrReleaseProvider.prototype);
    instance.downloads = new Map();
    return instance;
  }

  it("pairs the UpdateInfo back to its absolute download URL", () => {
    // `resolveFiles` is handed only an UpdateInfo, which has nowhere to carry
    // an absolute URL — the built-in providers rebuild one from a feed base URL
    // that a content-addressed artifact does not have.
    const instance = provider();
    const info = updateInfoFrom(update());
    instance.downloads.set("1.2.3", BLOSSOM);

    const [resolved] = instance.resolveFiles(info);
    expect(resolved.url.href).toBe(BLOSSOM);
    expect(resolved.info).toBe(info.files[0]);
  });

  it("refuses a version it never resolved rather than guessing a URL", () => {
    const instance = provider();
    expect(() => instance.resolveFiles(updateInfoFrom(update()))).toThrow(/1\.2\.3/);
  });
});

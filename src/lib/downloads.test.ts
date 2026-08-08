import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DOWNLOAD_TARGETS,
  detectOs,
  downloadUrl,
  formatBytes,
  manifestUrl,
} from "@/lib/downloads";

/** Real user-agent strings, since the ordering bugs only show up in real ones. */
const UA = {
  androidPhone: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipadDesktopMode: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

describe("detectOs", () => {
  it("reads Android before the Linux its user-agent also claims", () => {
    expect(detectOs(UA.androidPhone)).toBe("android");
  });

  it("reads iOS before the 'like Mac OS X' its user-agent also claims", () => {
    expect(detectOs(UA.iphone)).toBe("ios");
  });

  it("tells an iPad in desktop mode from a Mac by its touchscreen", () => {
    // Since iPadOS 13 both send an identical 'Macintosh' UA.
    expect(detectOs(UA.ipadDesktopMode, 5)).toBe("ios");
    expect(detectOs(UA.mac, 0)).toBe("macos");
  });

  it("recognizes the desktop platforms", () => {
    expect(detectOs(UA.windows)).toBe("windows");
    expect(detectOs(UA.linux)).toBe("linux");
    expect(detectOs(UA.chromeos)).toBe("linux");
  });

  it("returns undefined rather than guessing at an unknown agent", () => {
    expect(detectOs("some-crawler/1.0")).toBeUndefined();
    expect(detectOs("")).toBeUndefined();
  });
});

describe("download targets", () => {
  it("points every asset at an absolute URL on the downloads host", () => {
    for (const target of DOWNLOAD_TARGETS) {
      for (const asset of target.assets) {
        const url = downloadUrl(asset.file);
        expect(url).toMatch(/^https?:\/\//);
        expect(url.endsWith(`/${asset.file}`)).toBe(true);
      }
    }
  });

  it("carries no version in a filename, so the links never need updating", () => {
    for (const target of DOWNLOAD_TARGETS) {
      for (const asset of target.assets) {
        expect(asset.file).not.toMatch(/\d+\.\d+\.\d+/);
      }
    }
  });

  it("covers every detectable OS exactly once", () => {
    const seen = DOWNLOAD_TARGETS.map((t) => t.os);
    expect(new Set(seen).size).toBe(seen.length);
    for (const os of ["linux", "windows", "macos", "android", "ios"]) {
      expect(seen).toContain(os);
    }
  });

  it("names a manifest for every target that has files, and none for iOS", () => {
    for (const target of DOWNLOAD_TARGETS) {
      if (target.assets.length > 0) expect(target.manifest).toBeDefined();
      else expect(target.manifest).toBeUndefined();
    }
    // iOS ships no installable build; the page offers the web app instead.
    expect(DOWNLOAD_TARGETS.find((t) => t.os === "ios")?.assets).toEqual([]);
  });

});

/**
 * The page's links are only stable because CI publishes exactly these names.
 * Reading the workflows makes that a checked contract instead of a convention:
 * renaming a file in CI without renaming it here fails the suite, rather than
 * 404ing in production on the next tag.
 */
describe("the CI workflows that publish these files", () => {
  const workflows = [
    ".ngit/act/workflows/desktop.yml",
    ".ngit/act/workflows/release.yml",
  ].map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");

  it("publishes every stable filename the page links", () => {
    for (const target of DOWNLOAD_TARGETS) {
      for (const asset of target.assets) {
        expect(workflows, `${asset.file} is not published by any workflow`).toContain(asset.file);
      }
    }
  });

  it("writes every manifest key the page reads", () => {
    for (const target of DOWNLOAD_TARGETS) {
      for (const asset of target.assets) {
        expect(workflows, `manifest key ${asset.id} is never written`).toContain(`"${asset.id}"`);
      }
    }
  });

  it("writes the manifest each target names", () => {
    for (const name of new Set(DOWNLOAD_TARGETS.map((t) => t.manifest).filter(Boolean))) {
      expect(workflows).toContain(`latest-${name}.json`);
    }
  });
});

describe("manifestUrl", () => {
  it("names one manifest per platform family", () => {
    expect(manifestUrl("desktop")).toMatch(/\/latest-desktop\.json$/);
    expect(manifestUrl("android")).toMatch(/\/latest-android\.json$/);
  });
});

describe("formatBytes", () => {
  it("scales to the largest unit that keeps the number small", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(7 * 1024 * 1024)).toBe("7.0 MB");
    expect(formatBytes(112 * 1024 * 1024)).toBe("112 MB");
  });

  it("renders nothing for a size a manifest didn't supply", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateUpdateFeed } from "./validate-update-feed.mjs";

let temporaryDirectory;

afterEach(() => {
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function fixture(yaml, files = []) {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "armada-update-feed-"));
  const feed = path.join(temporaryDirectory, "latest.yml");
  fs.writeFileSync(feed, yaml);
  for (const file of files) fs.writeFileSync(path.join(temporaryDirectory, file), "payload");
  return feed;
}

describe("desktop update feed validation", () => {
  it("accepts metadata whose files are deployed beside it", () => {
    const feed = fixture(
      "path: Armada-1.2.3-Setup.exe\nfiles:\n  - url: Armada-1.2.3-Setup.exe\n  - url: Armada-1.2.3-Setup.exe.blockmap\n",
      ["Armada-1.2.3-Setup.exe", "Armada-1.2.3-Setup.exe.blockmap"],
    );
    expect(validateUpdateFeed(feed)).toEqual([
      "Armada-1.2.3-Setup.exe",
      "Armada-1.2.3-Setup.exe.blockmap",
    ]);
  });

  it("rejects metadata before a referenced payload can be published", () => {
    const feed = fixture(
      "path: Armada-1.2.3-linux-x86_64.AppImage\nfiles:\n  - url: Armada-1.2.3-linux-x86_64.AppImage\n",
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/missing payload/);
  });

  it("rejects stale metadata even when a new payload reused the same filename", () => {
    const feed = fixture(
      "files:\n  - url: Armada.AppImage\n    size: 99\n",
      ["Armada.AppImage"],
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/stale size/);
  });
});

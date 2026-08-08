import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateUpdateFeed } from "./validate-update-feed.mjs";

let temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

const PAYLOAD = "payload";
const DIGEST = crypto.createHash("sha512").update(PAYLOAD).digest("base64");
const SIZE = Buffer.byteLength(PAYLOAD);

function fixture(yaml, files = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "armada-update-feed-"));
  temporaryDirectories.push(directory);
  const feed = path.join(directory, "latest.yml");
  fs.writeFileSync(feed, yaml);
  for (const file of files) fs.writeFileSync(path.join(directory, file), PAYLOAD);
  return feed;
}

/** A feed in the shape electron-builder emits, with every field populated. */
function wellFormed({ version = "1.2.3", url = "Armada.AppImage" } = {}) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${url}`,
    `    sha512: ${DIGEST}`,
    `    size: ${SIZE}`,
    `path: ${url}`,
    `sha512: ${DIGEST}`,
    "",
  ].join("\n");
}

describe("desktop update feed validation", () => {
  it("accepts metadata whose files are deployed beside it", () => {
    const feed = fixture(wellFormed(), ["Armada.AppImage"]);
    expect(validateUpdateFeed(feed)).toEqual(["Armada.AppImage"]);
  });

  it("accepts a blockmap listed without its own digest", () => {
    const feed = fixture(
      [
        "version: 1.2.3",
        "files:",
        "  - url: Armada.AppImage",
        `    sha512: ${DIGEST}`,
        `    size: ${SIZE}`,
        "  - url: Armada.AppImage.blockmap",
        "path: Armada.AppImage",
        `sha512: ${DIGEST}`,
        "",
      ].join("\n"),
      ["Armada.AppImage", "Armada.AppImage.blockmap"],
    );
    expect(validateUpdateFeed(feed)).toContain("Armada.AppImage.blockmap");
  });

  it("rejects metadata before a referenced payload can be published", () => {
    const feed = fixture(wellFormed());
    expect(() => validateUpdateFeed(feed)).toThrow(/missing payload/);
  });

  it("rejects stale metadata even when a new payload reused the same filename", () => {
    const feed = fixture(
      wellFormed().replace(`size: ${SIZE}`, "size: 99"),
      ["Armada.AppImage"],
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/stale size/);
  });

  it("rejects a payload whose checksum does not match", () => {
    const feed = fixture(
      wellFormed().replace(DIGEST, "Zm9vYmFy"),
      ["Armada.AppImage"],
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/stale checksum/);
  });

  // The checks below all passed vacuously before: each was written as
  // "verify it if it is there", so omitting the field skipped the check
  // entirely and the feed validated clean.
  it("rejects an installer entry carrying no checksum", () => {
    const feed = fixture(
      "version: 1.2.3\nfiles:\n  - url: Armada.AppImage\n    size: 7\npath: Armada.AppImage\n",
      ["Armada.AppImage"],
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/no sha512/);
  });

  it("rejects an installer entry carrying no size", () => {
    const feed = fixture(
      `version: 1.2.3\nfiles:\n  - url: Armada.AppImage\n    sha512: ${DIGEST}\npath: Armada.AppImage\nsha512: ${DIGEST}\n`,
      ["Armada.AppImage"],
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/no size/);
  });

  it("verifies the top-level path and sha512 pair older clients read", () => {
    // Corrupt ONLY the trailing top-level digest; the files[] entry stays
    // correct, so a validator that checks just files[] sees nothing wrong.
    const feed = fixture(
      [
        "version: 1.2.3",
        "files:",
        "  - url: Armada.AppImage",
        `    sha512: ${DIGEST}`,
        `    size: ${SIZE}`,
        "path: Armada.AppImage",
        "sha512: Zm9vYmFy",
        "",
      ].join("\n"),
      ["Armada.AppImage"],
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/checksum/);
  });

  it("rejects a reference that points at another host", () => {
    const feed = fixture(
      [
        "version: 1.2.3",
        "files:",
        "  - url: https://evil.example/Armada.AppImage",
        `    sha512: ${DIGEST}`,
        `    size: ${SIZE}`,
        "path: https://evil.example/Armada.AppImage",
        `sha512: ${DIGEST}`,
        "",
      ].join("\n"),
      ["Armada.AppImage"],
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/must be relative/);
  });

  it("rejects a feed built for a different version than the release", () => {
    const feed = fixture(wellFormed({ version: "9.9.9" }), ["Armada.AppImage"]);
    expect(() => validateUpdateFeed(feed, { expectedVersion: "1.2.3" }))
      .toThrow(/version 9\.9\.9/);
    expect(validateUpdateFeed(feed, { expectedVersion: "9.9.9" })).toBeTruthy();
  });

  it("rejects a feed that names no version at all", () => {
    const feed = fixture(
      `files:\n  - url: Armada.AppImage\n    sha512: ${DIGEST}\n    size: ${SIZE}\n`,
      ["Armada.AppImage"],
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/no version/);
  });

  it("reports a malformed escape instead of throwing a bare URIError", () => {
    const feed = fixture(
      `version: 1.2.3\nfiles:\n  - url: "%zz"\n    sha512: ${DIGEST}\n    size: ${SIZE}\n`,
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/unsafe payload path/);
  });

  it("rejects a reference that escapes the feed directory", () => {
    const feed = fixture(
      `version: 1.2.3\nfiles:\n  - url: "%2e%2e%2fescaped"\n    sha512: ${DIGEST}\n    size: ${SIZE}\n`,
    );
    expect(() => validateUpdateFeed(feed)).toThrow(/unsafe payload path/);
  });
});

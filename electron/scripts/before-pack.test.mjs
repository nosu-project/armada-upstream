import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertPackInputs } = require("./before-pack.cjs");

let temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

function appDirectory({ db = true, web = true, helper = false } = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "armada-pack-inputs-"));
  temporaryDirectories.push(temporaryDirectory);
  fs.mkdirSync(path.join(temporaryDirectory, "dist"));
  if (db) fs.writeFileSync(path.join(temporaryDirectory, "db.cjs"), "module.exports = {};");
  if (web) fs.writeFileSync(path.join(temporaryDirectory, "dist", "index.html"), "<html></html>");
  if (helper) {
    const helperPath = path.join(
      temporaryDirectory,
      "generated",
      "hevc",
      "x64",
      "armada-hevc-publisher",
    );
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.writeFileSync(helperPath, "publisher", { mode: 0o755 });
  }
  return temporaryDirectory;
}

describe("desktop package staging guard", () => {
  it("accepts the staged web client and database bridge", () => {
    expect(() => assertPackInputs(appDirectory(), { platform: "win32" })).not.toThrow();
  });

  it("names missing release inputs before packaging starts", () => {
    expect(() => assertPackInputs(appDirectory({ db: false }))).toThrow(/db\.cjs/);
    expect(() => assertPackInputs(appDirectory({ web: false }))).toThrow(/dist.index\.html/);
  });

  it("requires an executable publisher only for Linux packages", () => {
    expect(() =>
      assertPackInputs(appDirectory({ helper: true }), { platform: "linux", arch: "x64" }),
    ).not.toThrow();
    expect(() =>
      assertPackInputs(appDirectory(), { platform: "linux", arch: "x64" }),
    ).toThrow(/generated.hevc.x64.armada-hevc-publisher/);
    expect(() => assertPackInputs(appDirectory(), { platform: "darwin" })).not.toThrow();
  });
});

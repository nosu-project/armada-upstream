import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertPackInputs } = require("./before-pack.cjs");

let temporaryDirectory;

afterEach(() => {
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function appDirectory({ db = true, web = true } = {}) {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "armada-pack-inputs-"));
  fs.mkdirSync(path.join(temporaryDirectory, "dist"));
  if (db) fs.writeFileSync(path.join(temporaryDirectory, "db.cjs"), "module.exports = {};");
  if (web) fs.writeFileSync(path.join(temporaryDirectory, "dist", "index.html"), "<html></html>");
  return temporaryDirectory;
}

describe("desktop package staging guard", () => {
  it("accepts the staged web client and database bridge", () => {
    expect(() => assertPackInputs(appDirectory())).not.toThrow();
  });

  it("names missing release inputs before packaging starts", () => {
    expect(() => assertPackInputs(appDirectory({ db: false }))).toThrow(/db\.cjs/);
    expect(() => assertPackInputs(appDirectory({ web: false }))).toThrow(/dist.index\.html/);
  });
});

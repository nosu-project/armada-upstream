import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const here = path.dirname(fileURLToPath(import.meta.url));

// Windows shows a renderer `new Notification()` as an Action Center toast only
// when the process's AppUserModelID matches the one the NSIS installer stamped
// on the Start Menu shortcut — and the installer takes that from
// electron-builder.yml's `appId`. The two strings live in different files
// with nothing tying them together, and a drift is silent: the check
// succeeds, the toast is dropped, and nothing logs. This is the tie.
describe("Windows AppUserModelId", () => {
  it("is the same string electron-builder stamps on the Start Menu shortcut", () => {
    const builder = yaml.load(readFileSync(path.join(here, "electron-builder.yml"), "utf8"));
    const main = readFileSync(path.join(here, "main.js"), "utf8");
    const calls = [...main.matchAll(/app\.setAppUserModelId\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);

    expect(builder.appId, "electron-builder.yml has no appId").toBeTruthy();
    expect(calls, "main.js never calls app.setAppUserModelId").toHaveLength(1);
    expect(calls[0]).toBe(builder.appId);
  });
});

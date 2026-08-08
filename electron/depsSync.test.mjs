import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rootManifest = require("../package.json");
const electronManifest = require("./package.json");

// The shell's own dependencies are declared in electron/package.json, which is
// what `electron-builder` installs and what the packaged app loads at runtime.
// The unit tests, though, run from the ROOT vitest project against the root
// node_modules — `.ngit/act/workflows/test.yml` only does a root `npm ci`, so
// anything the tests require has to resolve there or the suite fails outright
// (it did: `Cannot find module '@jellybrick/dbus-next'` took two files with it,
// and those two happened to be the ones with the most delicate logic).
//
// So these packages are declared twice on purpose. That is a drift hazard —
// tests would keep passing against a version production no longer uses — and
// this test is the thing that makes the duplication safe. Add a package here
// whenever an electron/*.test.mjs needs it in the root manifest.
const SHARED_PACKAGES = ["@jellybrick/dbus-next", "js-yaml"];

function declaredRange(manifest, name) {
  return (
    manifest.dependencies?.[name] ??
    manifest.devDependencies?.[name] ??
    manifest.optionalDependencies?.[name] ??
    null
  );
}

describe("electron test dependencies", () => {
  it.each(SHARED_PACKAGES)(
    "declares the same %s range in the root and electron manifests",
    (name) => {
      const electronRange = declaredRange(electronManifest, name);
      const rootRange = declaredRange(rootManifest, name);

      expect(electronRange).not.toBeNull();
      expect(rootRange).toBe(electronRange);
    },
  );

  it("resolves every shared package from the root install", () => {
    for (const name of SHARED_PACKAGES) {
      expect(() => require.resolve(name)).not.toThrow();
    }
  });
});

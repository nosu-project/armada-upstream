import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The shell `require`s these bundles as plain JS, so neither tsc nor an
// unused-export sweep sees what it takes from them.
const BUNDLES: Record<string, () => Promise<Record<string, unknown>>> = {
  "updateFeed.cjs": () => import("./desktopUpdate"),
  "db.cjs": () => import("./db/electronMain"),
};

const ELECTRON = path.resolve(import.meta.dirname, "../../electron");

function requiredNames(bundle: string): string[] {
  const pattern = new RegExp(
    String.raw`const\s*\{([^}]*)\}\s*=\s*require\(\s*["']\./${bundle.replace(".", "\\.")}["']\s*\)`,
    "g",
  );
  const names = new Set<string>();
  for (const file of readdirSync(ELECTRON)) {
    if (!/\.(c?js|mjs)$/.test(file) || file === bundle) continue;
    const source = readFileSync(path.join(ELECTRON, file), "utf8");
    for (const match of source.matchAll(pattern)) {
      for (const part of match[1].split(",")) {
        const name = part.split(":")[0].trim();
        if (name) names.add(name);
      }
    }
  }
  return [...names];
}

describe("electron bundle exports", () => {
  for (const [bundle, load] of Object.entries(BUNDLES)) {
    it(`${bundle} exports everything the shell requires from it`, async () => {
      const names = requiredNames(bundle);
      expect(names.length).toBeGreaterThan(0);
      const exports = await load();
      for (const name of names) expect(exports[name], name).toBeTypeOf("function");
    });
  }
});

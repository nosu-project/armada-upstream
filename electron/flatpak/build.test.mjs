import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const buildScript = fs.readFileSync(
  path.resolve(process.cwd(), "electron/flatpak/build.sh"),
  "utf8",
);

describe("Flatpak bundle update origin", () => {
  it("defaults to Armada's published OSTree repository", () => {
    expect(buildScript).toContain(
      "ARMADA_FLATPAK_REPO_URL=${ARMADA_FLATPAK_REPO_URL:-https://armada.buzz/downloads/flatpak/}",
    );
  });

  it("embeds the update origin in every builder path", () => {
    const bundleCommands = buildScript
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("flatpak build-bundle "));

    expect(bundleCommands).toHaveLength(3);
    for (const command of bundleCommands) {
      expect(command).toContain('--repo-url="$ARMADA_FLATPAK_REPO_URL"');
    }
  });

  it("forwards the origin into both sandboxed Builder variants", () => {
    const forwardedOrigins = buildScript.match(
      /--env=ARMADA_FLATPAK_REPO_URL="\$ARMADA_FLATPAK_REPO_URL"/g,
    );
    expect(forwardedOrigins).toHaveLength(2);
  });
});

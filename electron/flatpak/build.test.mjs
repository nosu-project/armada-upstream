// @vitest-environment node

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const buildScript = fs.readFileSync(
  path.resolve(process.cwd(), "electron/flatpak/build.sh"),
  "utf8",
);

describe("Flatpak bundle", () => {
  // The bundle is unsigned and carries no origin. npkg (pkg.soapbox.pub) is the
  // distribution channel: it hash-verifies the bundle against the signed
  // kind-30622 release event and re-signs its own OSTree summary, so a signature
  // or an embedded remote here would be discarded — and an embedded origin would
  // point a direct install at a remote nothing serves.
  it("embeds no update origin in any builder path", () => {
    const bundleCommands = buildScript
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("flatpak build-bundle "));

    expect(bundleCommands).toHaveLength(3);
    for (const command of bundleCommands) {
      expect(command).not.toContain("--repo-url");
    }
    expect(buildScript).not.toContain("ARMADA_FLATPAK_REPO_URL");
    expect(buildScript).not.toContain("armada.buzz");
  });

  it("passes no signing credentials to any Flatpak command", () => {
    expect(buildScript).not.toContain("--gpg-sign");
    expect(buildScript).not.toContain("--gpg-keys");
    expect(buildScript).not.toContain("FLATPAK_GPG_KEY");
    expect(buildScript).not.toContain("FLATPAK_GPG_PUBLIC_KEY");
  });

  // sign.sh is gone: there is no post-build signing phase to invoke.
  it("has no signing script beside it", () => {
    expect(
      fs.existsSync(path.resolve(process.cwd(), "electron/flatpak/sign.sh")),
    ).toBe(false);
  });
});

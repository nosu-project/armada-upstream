// @vitest-environment node

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const readme = fs.readFileSync(
  path.resolve(process.cwd(), "electron/README.md"),
  "utf8",
);
const flatpakDocs = readme.slice(
  readme.indexOf("## Flatpak"),
  readme.indexOf("## CI"),
);
const shellBlocks = [...flatpakDocs.matchAll(/```sh\n([\s\S]*?)```/g)].map(
  ([, commands]) => commands,
);

describe("Flatpak trust migration documentation", () => {
  it("does not recreate the hosted Armada remote without GPG verification", () => {
    expect(flatpakDocs).toContain(
      "https://armada.buzz/downloads/flatpak/armada-flatpak.gpg",
    );
    expect(flatpakDocs).toContain("--gpg-import=./armada-flatpak.gpg");
    expect(flatpakDocs).toContain("--gpg-verify");
    const hostedRemoteBlocks = shellBlocks.filter(
      (commands) =>
        commands.includes("flatpak remote-add") &&
        commands.includes("armada https://armada.buzz/downloads/flatpak/"),
    );
    expect(hostedRemoteBlocks.length).toBeGreaterThan(0);
    for (const commands of hostedRemoteBlocks) {
      expect(commands).not.toContain("--no-gpg-verify");
    }
  });

  it("keeps unsigned system installs recoverable without deleting profiles", () => {
    expect(flatpakDocs).toContain(
      "sudo flatpak update --system buzz.armada.app",
    );
    expect(flatpakDocs).toContain(
      "sudo flatpak uninstall --system buzz.armada.app",
    );
    expect(flatpakDocs).toContain(
      "flatpak install --user ./Armada.flatpak\n" +
        "flatpak info --user buzz.armada.app\n" +
        'armada_system_origin="$(flatpak info --system --show-origin buzz.armada.app)"\n' +
        "sudo flatpak uninstall --system buzz.armada.app",
    );
    expect(flatpakDocs).toContain("Do not add `--delete-data`");
  });

  it("gates the trust flip and documents independent fingerprint verification", () => {
    expect(flatpakDocs).toContain(
      "Never perform either trust flip before the signed release is available",
    );
    expect(flatpakDocs).toContain("independently authenticated Armada channel");
    expect(flatpakDocs).toContain(
      "comparing only those files does not authenticate the key",
    );
    expect(flatpakDocs).toContain("FLATPAK_GPG_EXPECTED_FINGERPRINT");
  });
});

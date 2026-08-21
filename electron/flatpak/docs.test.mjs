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
// Prose is hard-wrapped at 80 columns, so a sentence a reader sees as one line
// is not one line in the file, and which words land either side of a break
// moves whenever a paragraph is edited. Assert prose against a whitespace-
// collapsed copy: what these tests care about is that the claim is still made,
// not where it wraps. Command text keeps using `flatpakDocs`/`shellBlocks`,
// where the exact bytes ARE the thing being asserted.
const flatpakProse = flatpakDocs.replace(/\s+/g, " ");

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
    expect(flatpakProse).toContain("Do not add `--delete-data`");
  });

  it("gates the trust flip and documents independent fingerprint verification", () => {
    expect(flatpakProse).toContain(
      "Never perform either trust flip before the signed release is available",
    );
    expect(flatpakProse).toContain(
      "comparing only those files does not authenticate the key",
    );
    expect(flatpakProse).toContain("FLATPAK_GPG_EXPECTED_FINGERPRINT");
  });

  // The out-of-band channel has to be a place a reader can actually go. Prose
  // naming "an independently authenticated channel" is what these instructions
  // used to say, and nothing published one — so assert the coordinate, the
  // path, and a check that runs.
  it("names the nsite manifest as the channel that vouches for the key", () => {
    const announcedPath = "/.well-known/armada-flatpak.fingerprint";
    expect(flatpakDocs).toContain(
      `https://armada.buzz${announcedPath}`,
    );
    expect(flatpakProse).toContain(
      "35128:781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5:armada",
    );
    const verificationBlocks = shellBlocks.filter((commands) =>
      commands.includes("nak req -k 35128"),
    );
    expect(verificationBlocks.length).toBeGreaterThan(0);
    for (const commands of verificationBlocks) {
      // The signature check is the whole point; a hash comparison against an
      // unverified event proves nothing.
      expect(commands).toContain("nak verify");
      expect(commands).toContain(`select(.[1] == "${announcedPath}")`);
      expect(commands).toContain("sha256sum ./armada-flatpak.announced");
    }
    // The claim must stay honest about what the separation buys.
    expect(flatpakProse).toContain(
      "independent of the web server, not of Armada",
    );
  });

  it("keeps the announcement a committed file rather than an operator's memory", () => {
    const committed = fs.readFileSync(
      path.resolve(process.cwd(), "public/.well-known/armada-flatpak.fingerprint"),
      "utf8",
    );
    expect(committed).toMatch(/^[0-9A-F]{40}\n$/);
    expect(flatpakDocs).toContain(
      "`public/.well-known/armada-flatpak.fingerprint`",
    );
  });
});

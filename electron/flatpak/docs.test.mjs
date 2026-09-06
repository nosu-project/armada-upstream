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

describe("Flatpak documentation", () => {
  // The hosted OSTree repository is gone. Instructions that add a remote for
  // it would hand users a dead origin, and instructions that disable GPG
  // verification for anything but a local file:// repo would be worse.
  it("never adds the retired hosted remote, and never disables verification for a hosted one", () => {
    for (const commands of shellBlocks) {
      expect(commands).not.toContain("armada.buzz/downloads/flatpak/");
      if (commands.includes("--no-gpg-verify")) {
        expect(commands).toContain("file://");
      }
    }
    expect(flatpakProse).toContain("There is no update repository.");
    expect(flatpakProse).toContain("The bundle embeds no origin URL");
  });

  it("describes the upgrade as installing the next bundle over the running one", () => {
    expect(
      shellBlocks.filter((commands) =>
        commands.includes("flatpak install --user ./Armada-vX.Y.Z.flatpak"),
      ).length,
    ).toBeGreaterThan(0);
    expect(flatpakProse).toContain("`checkForWebBundleUpdate` in `electron/main.js`");
    // The retired origin embedded in older bundles is disabled, not deleted,
    // and the profile is preserved either way.
    expect(flatpakDocs).toContain(
      'flatpak remote-modify --user --disable \\\n  "$(flatpak info --user --show-origin buzz.armada.app)"',
    );
    expect(flatpakProse).toContain("keeps the profile under `~/.var/app/buzz.armada.app`");
  });

  it("keeps unsigned system installs recoverable without deleting profiles", () => {
    expect(flatpakDocs).toContain(
      "sudo flatpak uninstall --system buzz.armada.app",
    );
    expect(flatpakDocs).toContain(
      "flatpak install --user ./Armada-vX.Y.Z.flatpak\n" +
        "flatpak info --user buzz.armada.app\n" +
        'armada_system_origin="$(flatpak info --system --show-origin buzz.armada.app)"\n' +
        "sudo flatpak uninstall --system buzz.armada.app",
    );
    expect(flatpakProse).toContain("Do not add `--delete-data`");
  });

  it("documents the signing secrets and independent fingerprint verification", () => {
    expect(flatpakProse).toContain("FLATPAK_GPG_EXPECTED_FINGERPRINT");
    expect(flatpakProse).toContain("FLATPAK_GPG_PRIVATE_KEY_BASE64");
    // The key travels with the bundle it vouches for, so the README must say
    // plainly that comparing it against a same-host copy proves nothing.
    expect(flatpakProse).toContain("cannot authenticate itself");
    expect(flatpakProse).toContain(
      "Comparing the embedded key only against a copy fetched from the same host would not authenticate it",
    );
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
      // The key being checked is the one the INSTALL trusts — read back out of
      // Flatpak's own keyring for the origin — not a copy downloaded from
      // anywhere.
      expect(commands).toContain(
        '~/.local/share/flatpak/repo/"$armada_origin".trustedkeys.gpg',
      );
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

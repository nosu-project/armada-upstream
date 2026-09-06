import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

// Each signing case spawns a real /bin/sh plus ~20 node-based stub binaries,
// which runs comfortably under a second alone but not against the 5s default
// when the whole suite is competing for cores.
vi.setConfig({ testTimeout: 30_000 });

const buildScript = fs.readFileSync(
  path.resolve(process.cwd(), "electron/flatpak/build.sh"),
  "utf8",
);
const signScript = fs.readFileSync(
  path.resolve(process.cwd(), "electron/flatpak/sign.sh"),
  "utf8",
);

function makeSigningFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "armada-flatpak-sign-"));
  const flatpakDir = path.join(root, "electron", "flatpak");
  const releaseDir = path.join(root, "electron", "release");
  const repoDir = path.join(releaseDir, "flatpak-repo");
  const script = path.join(flatpakDir, "sign.sh");
  const commandLog = path.join(root, "flatpak-commands.jsonl");
  const fakeBin = path.join(root, "bin");

  fs.mkdirSync(flatpakDir, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(script, signScript, { mode: 0o755 });
  fs.writeFileSync(commandLog, "");
  // Signature state has to be modelled, not just recorded: sign.sh skips a
  // commit that is already signed (ostree gpg-sign APPENDS, so signing twice
  // leaves duplicates) and then asserts every ref ended up signed.
  const signedLog = path.join(root, "flatpak-signed.txt");
  fs.writeFileSync(signedLog, "");

  const fakeFlatpak = `#!${process.execPath}
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
// The capability probe is a question about this flatpak, not an operation on
// the repository, so it stays out of the command log the ordering assertions
// read. MOCK_NO_SUMMARY_INDEX is a flatpak too old to generate one.
if (args.includes("--help")) {
  process.stdout.write("Usage:\\n  flatpak " + args[0] + " [OPTION...]\\n");
  if (process.env.MOCK_NO_SUMMARY_INDEX !== "1") {
    process.stdout.write("  --no-summary-index  Don't generate a summary index\\n");
  }
  process.exit(0);
}
fs.appendFileSync(process.env.MOCK_COMMAND_LOG, JSON.stringify(args) + "\\n");
if (args[0] === process.env.MOCK_FLATPAK_FAIL) {
  process.exit(23);
}
if (args[0] === "build-update-repo") {
  // Real build-update-repo writes the summary, its signature, the summary
  // index and the index's immutable signature shard, which sign.sh now
  // requires before it will publish anything.
  const repo = args.at(-1);
  fs.writeFileSync(path.join(repo, "summary"), "summary");
  fs.writeFileSync(path.join(repo, "summary.sig"), "summary signature");
  fs.writeFileSync(path.join(repo, "summary.idx"), "summary index");
  fs.writeFileSync(path.join(repo, "summary.idx.sig"), "summary index signature");
  fs.mkdirSync(path.join(repo, "summaries"), { recursive: true });
  if (process.env.MOCK_NO_INDEX_SIG !== "1") {
    const sha = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(repo, "summary.idx")))
      .digest("hex");
    fs.writeFileSync(path.join(repo, "summaries", sha + ".idx.sig"), "shard");
  }
}
if (args[0] === "build-sign") {
  // Signs the application ref, and only that one — the .Debug extension and
  // the appstream refs are left for sign.sh's own loop to pick up.
  fs.appendFileSync(process.env.MOCK_SIGNED_LOG, "C".repeat(64) + "\\n");
}
if (args[0] === "build-bundle") {
  fs.writeFileSync(args.at(-3), "signed bundle");
}
`;
  fs.writeFileSync(path.join(fakeBin, "flatpak"), fakeFlatpak, {
    mode: 0o755,
  });
  const fakeGpg = `#!${process.execPath}
const fingerprints = (process.env.MOCK_PUBLIC_FINGERPRINTS || "").split(",").filter(Boolean);
for (const fingerprint of fingerprints) {
  process.stdout.write("pub:-:4096:1:0000000000000000:0:0:::::::\\n");
  process.stdout.write("fpr:::::::::" + fingerprint + ":\\n");
  process.stdout.write("sub:-:4096:1:1111111111111111:0:0:::::::\\n");
  process.stdout.write("fpr:::::::::FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:\\n");
}
`;
  fs.writeFileSync(path.join(fakeBin, "gpg"), fakeGpg, { mode: 0o755 });
  const fakeOstree = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_COMMAND_LOG, JSON.stringify(args) + "\\n");
// One distinct commit per ref, so "already signed" can't be confused between
// two refs the way a shared id would.
const commits = {
  "app/buzz.armada.app/x86_64/stable": "C",
  "appstream/x86_64": "A",
  "appstream2/x86_64": "B",
  "runtime/buzz.armada.app.Debug/x86_64/stable": "D",
  "appstream/x86_64/ignored": "E",
};
if (args[0] === "refs") {
  if (process.env.MOCK_NO_APPSTREAM !== "1") {
    process.stdout.write("app/buzz.armada.app/x86_64/stable\\n");
    process.stdout.write("appstream/x86_64\\n");
    process.stdout.write("appstream2/x86_64\\n");
    // flatpak-builder emits a .Debug runtime extension holding the separated
    // debug symbols. Nothing signed it before, and consumers verify every ref.
    process.stdout.write("runtime/buzz.armada.app.Debug/x86_64/stable\\n");
    process.stdout.write("appstream/x86_64/ignored\\n");
  }
} else if (args[0] === "rev-parse") {
  const ref = args.at(-1);
  process.stdout.write((commits[ref] || "F").repeat(64) + "\\n");
} else if (args[0] === "show") {
  const signed = fs.readFileSync(process.env.MOCK_SIGNED_LOG, "utf8").split("\\n");
  if (signed.includes(args.at(-1))) {
    process.stdout.write("Found 1 signature:\\n");
    process.stdout.write("  Signature made using RSA key ID DEADBEEF\\n");
  }
} else if (args[0] === "gpg-sign") {
  // MOCK_UNSIGNABLE_COMMIT models a signature that silently does not take, so
  // the assertion pass in sign.sh can be tested rather than assumed.
  if (args.at(-2) !== process.env.MOCK_UNSIGNABLE_COMMIT) {
    fs.appendFileSync(process.env.MOCK_SIGNED_LOG, args.at(-2) + "\\n");
  }
}
`;
  fs.writeFileSync(path.join(fakeBin, "ostree"), fakeOstree, {
    mode: 0o755,
  });

  return {
    bundle: path.join(
      releaseDir,
      `Armada-flatpak-${os.machine()}.flatpak`,
    ),
    commandLog,
    fakeBin,
    signedLog,
    root,
    script,
  };
}

function runSigningScript(fixture, overrides) {
  const env = {
    ...process.env,
    PATH: `${fixture.fakeBin}:${process.env.PATH}`,
    MOCK_COMMAND_LOG: fixture.commandLog,
    MOCK_SIGNED_LOG: fixture.signedLog,
    ...overrides,
  };
  for (const name of [
    "ARMADA_FLATPAK_RELEASE_DIR",
    "FLATPAK_GPG_KEY",
    "FLATPAK_GPG_PUBLIC_KEY",
    "GNUPGHOME",
  ]) {
    if (env[name] === undefined) delete env[name];
  }
  return spawnSync("/bin/sh", [fixture.script], {
    encoding: "utf8",
    env,
  });
}

function readCommandLog(fixture) {
  return fs
    .readFileSync(fixture.commandLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Flatpak bundle origin", () => {
  // Nothing serves an OSTree repository for this app any more — the
  // self-hosted one was retired — so a bundle that embedded an origin would
  // point every install at a dead remote. No builder path may pass one, and
  // no environment variable may reintroduce one.
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
    expect(signScript).not.toMatch(/^\s*flatpak build-bundle.*--repo-url|^\s*--repo-url/m);
    expect(signScript).not.toContain("ARMADA_FLATPAK_REPO_URL");
  });

  it("keeps signing credentials out of every build path", () => {
    expect(buildScript).not.toContain("--gpg-sign");
    expect(buildScript).not.toContain("--gpg-keys");
    expect(buildScript.indexOf("Do not pass FLATPAK_GPG_KEY")).toBeLessThan(
      buildScript.indexOf("builder=system"),
    );
  });
});

describe("Flatpak post-build signing", () => {
  it("can sign an absolute prebuilt release directory from a trusted copied script", () => {
    const fixture = makeSigningFixture();
    try {
      const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
      const publicKey = path.join(fixture.root, "armada-flatpak.gpg");
      const releaseDir = path.join(fixture.root, "prebuilt release");
      const repoDir = path.join(releaseDir, "flatpak-repo");
      const bundle = path.join(
        releaseDir,
        `Armada-flatpak-${os.machine()}.flatpak`,
      );
      fs.mkdirSync(repoDir, { recursive: true });
      fs.writeFileSync(publicKey, "public key");
      fs.writeFileSync(bundle, "unsigned bundle");

      const result = runSigningScript(fixture, {
        ARMADA_FLATPAK_RELEASE_DIR: releaseDir,
        FLATPAK_GPG_KEY: fingerprint,
        FLATPAK_GPG_PUBLIC_KEY: publicKey,
        MOCK_PUBLIC_FINGERPRINTS: fingerprint,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(fs.readFileSync(bundle, "utf8")).toBe("signed bundle");
      expect(
        fs.readFileSync(path.join(repoDir, "armada-flatpak.gpg"), "utf8"),
      ).toBe("public key");
      expect(readCommandLog(fixture)[0]).toEqual([
        "build-sign",
        `--gpg-sign=${fingerprint}`,
        repoDir,
        "buzz.armada.app",
        "stable",
      ]);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects a relative or missing release-directory override", () => {
    const fixture = makeSigningFixture();
    try {
      const attempts = [
        {
          value: "relative/release",
          message: "must be an absolute directory",
        },
        {
          value: path.join(fixture.root, "missing-release"),
          message: "does not exist",
        },
      ];
      for (const attempt of attempts) {
        const result = runSigningScript(fixture, {
          ARMADA_FLATPAK_RELEASE_DIR: attempt.value,
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(attempt.message);
      }
      expect(readCommandLog(fixture)).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("signs the exported commit and summary before atomically replacing the keyed bundle", () => {
    const fixture = makeSigningFixture();
    try {
      const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
      const keyDir = path.join(fixture.root, "release keys");
      const publicKey = path.join(keyDir, "armada-flatpak.gpg");
      const gpgHome = path.join(fixture.root, "gnupg home");
      fs.mkdirSync(keyDir);
      fs.mkdirSync(gpgHome);
      fs.writeFileSync(publicKey, "public key");
      fs.writeFileSync(fixture.bundle, "unsigned bundle");

      const result = runSigningScript(fixture, {
        FLATPAK_GPG_KEY: "0123 4567 89ab cdef 0123 4567 89ab cdef 0123 4567",
        FLATPAK_GPG_PUBLIC_KEY: publicKey,
        GNUPGHOME: gpgHome,
        MOCK_PUBLIC_FINGERPRINTS: fingerprint,
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(fs.readFileSync(fixture.bundle, "utf8")).toBe("signed bundle");

      const commands = readCommandLog(fixture);
      const repoDir = path.join(
        fixture.root,
        "electron",
        "release",
        "flatpak-repo",
      );
      const publishedPublicKey = path.join(repoDir, "armada-flatpak.gpg");
      const signingOptions = [
        `--gpg-sign=${fingerprint}`,
        `--gpg-homedir=${fs.realpathSync(gpgHome)}`,
      ];
      expect(fs.readFileSync(publishedPublicKey, "utf8")).toBe("public key");
      expect(
        fs.readFileSync(
          path.join(repoDir, "armada-flatpak.fingerprint"),
          "utf8",
        ),
      ).toBe(`${fingerprint}\n`);
      const firstIndexOf = (name) =>
        commands.findIndex(([command]) => command === name);
      const signingCalls = commands.filter(([command]) => command === "gpg-sign");
      const updateRepo = commands.find(
        ([command]) => command === "build-update-repo",
      );
      const stagedPublicKey = updateRepo
        .find((argument) => argument.startsWith("--gpg-import="))
        ?.slice("--gpg-import=".length);
      expect(stagedPublicKey).toContain("/.flatpak-key.");
      expect(stagedPublicKey).toMatch(/\/armada-flatpak[.]gpg$/);
      expect(commands[0]).toEqual([
        "build-sign",
        ...signingOptions,
        repoDir,
        "buzz.armada.app",
        "stable",
      ]);
      expect(commands[1]).toEqual([
        "refs",
        `--repo=${repoDir}`,
      ]);

      // EVERY ref the repository advertises ends up signed, exactly once.
      // `build-sign` above covers the application (commit C); the loop signs
      // the rest, including the `.Debug` runtime extension flatpak-builder
      // emits — consumers verify each ref, so one unsigned commit fails the
      // whole pull. Signing twice would leave duplicate signatures, since
      // `ostree gpg-sign` appends.
      expect(signingCalls.map((command) => command.at(-2))).toEqual(
        ["A", "B", "D", "E"].map((letter) => letter.repeat(64)),
      );
      for (const command of signingCalls) {
        expect(command).toEqual([
          "gpg-sign",
          `--repo=${repoDir}`,
          `--gpg-homedir=${fs.realpathSync(gpgHome)}`,
          expect.any(String),
          fingerprint,
        ]);
      }

      // Order that matters: sign, then the metadata pass, then the bundle.
      expect(
        Math.max(
          ...commands.flatMap(([command], index) =>
            command === "gpg-sign" ? [index] : [],
          ),
        ),
      ).toBeLessThan(firstIndexOf("build-update-repo"));
      expect(firstIndexOf("build-update-repo")).toBeLessThan(
        firstIndexOf("build-bundle"),
      );
      expect(updateRepo).toEqual([
        "build-update-repo",
        "--no-update-appstream",
        ...signingOptions,
        `--gpg-import=${stagedPublicKey}`,
        repoDir,
      ]);
      // No --repo-url: the bundle embeds the key (so the install verifies it)
      // and nothing else, since there is no repository for it to name.
      expect(commands.find(([command]) => command === "build-bundle")).toEqual([
        "build-bundle",
        `--gpg-keys=${stagedPublicKey}`,
        repoDir,
        expect.stringContaining("/.flatpak-sign."),
        "buzz.armada.app",
        "stable",
      ]);
      expect(commands[7].at(-3)).not.toBe(fixture.bundle);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses to publish when any ref is left unsigned", () => {
    const fixture = makeSigningFixture();
    try {
      const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
      const publicKey = path.join(fixture.root, "armada-flatpak.gpg");
      const repoDir = path.join(
        fixture.root,
        "electron",
        "release",
        "flatpak-repo",
      );
      fs.writeFileSync(publicKey, "public key");
      fs.writeFileSync(fixture.bundle, "unsigned bundle");

      // "D" is the .Debug runtime extension — the ref that shipped unsigned
      // because the signing loop only covered appstream, and which a consumer
      // then refused with "GPG verification enabled, but no signatures found".
      const result = runSigningScript(fixture, {
        FLATPAK_GPG_KEY: fingerprint,
        FLATPAK_GPG_PUBLIC_KEY: publicKey,
        MOCK_PUBLIC_FINGERPRINTS: fingerprint,
        MOCK_UNSIGNABLE_COMMIT: "D".repeat(64),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "runtime/buzz.armada.app.Debug/x86_64/stable",
      );
      expect(result.stderr).toContain("is unsigned");
      // Nothing is published on the way out: the previous bundle stands and
      // the publisher identity never appears beside the repository.
      expect(fs.readFileSync(fixture.bundle, "utf8")).toBe("unsigned bundle");
      expect(fs.existsSync(path.join(repoDir, "armada-flatpak.gpg"))).toBe(
        false,
      );
      expect(
        readCommandLog(fixture).map(([command]) => command),
      ).not.toContain("build-bundle");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects partial or unreadable key configuration before invoking Flatpak", () => {
    const fixture = makeSigningFixture();
    try {
      const publicKey = path.join(fixture.root, "armada-flatpak.gpg");
      fs.writeFileSync(publicKey, "public key");

      const attempts = [
        {
          FLATPAK_GPG_KEY: "0123456789ABCDEF0123456789ABCDEF01234567",
        },
        { FLATPAK_GPG_PUBLIC_KEY: publicKey },
        {
          FLATPAK_GPG_KEY: "0123456789ABCDEF0123456789ABCDEF01234567",
          FLATPAK_GPG_PUBLIC_KEY: path.join(fixture.root, "missing.gpg"),
        },
      ];
      for (const attempt of attempts) {
        const result = runSigningScript(fixture, attempt);
        expect(result.status).not.toBe(0);
      }

      expect(readCommandLog(fixture)).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects a mismatched or multi-primary public export before signing", () => {
    const fixture = makeSigningFixture();
    try {
      const publicKey = path.join(fixture.root, "armada-flatpak.gpg");
      fs.writeFileSync(publicKey, "public key");
      const signingFingerprint =
        "0123456789ABCDEF0123456789ABCDEF01234567";
      const otherFingerprint =
        "89ABCDEF0123456789ABCDEF0123456789ABCDEF";

      const mismatched = runSigningScript(fixture, {
        FLATPAK_GPG_KEY: signingFingerprint,
        FLATPAK_GPG_PUBLIC_KEY: publicKey,
        MOCK_PUBLIC_FINGERPRINTS: otherFingerprint,
      });
      expect(mismatched.status).not.toBe(0);
      expect(mismatched.stderr).toContain(
        "does not match the primary key",
      );

      const multiple = runSigningScript(fixture, {
        FLATPAK_GPG_KEY: signingFingerprint,
        FLATPAK_GPG_PUBLIC_KEY: publicKey,
        MOCK_PUBLIC_FINGERPRINTS: `${signingFingerprint},${otherFingerprint}`,
      });
      expect(multiple.status).not.toBe(0);
      expect(multiple.stderr).toContain("exactly one primary public key");

      expect(readCommandLog(fixture)).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not publish identity files or replace the bundle when signing fails", () => {
    const fixture = makeSigningFixture();
    try {
      const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
      const publicKey = path.join(fixture.root, "armada-flatpak.gpg");
      const repoDir = path.join(
        fixture.root,
        "electron",
        "release",
        "flatpak-repo",
      );
      fs.writeFileSync(publicKey, "public key");
      fs.writeFileSync(fixture.bundle, "unsigned bundle");

      const result = runSigningScript(fixture, {
        FLATPAK_GPG_KEY: fingerprint,
        FLATPAK_GPG_PUBLIC_KEY: publicKey,
        MOCK_FLATPAK_FAIL: "build-bundle",
        MOCK_PUBLIC_FINGERPRINTS: fingerprint,
      });

      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(fixture.bundle, "utf8")).toBe("unsigned bundle");
      expect(fs.existsSync(path.join(repoDir, "armada-flatpak.gpg"))).toBe(
        false,
      );
      expect(
        fs.existsSync(path.join(repoDir, "armada-flatpak.fingerprint")),
      ).toBe(false);
      expect(
        fs
          .readdirSync(repoDir)
          .some((name) => name.startsWith(".flatpak-key.")),
      ).toBe(false);
      // Reached the bundle build and stopped there: signing ran to completion,
      // the metadata pass ran, and nothing after build-bundle happened.
      const attempted = readCommandLog(fixture).map(([command]) => command);
      expect(attempted.at(-1)).toBe("build-bundle");
      expect(attempted.filter((command) => command === "build-bundle")).toHaveLength(1);
      expect(attempted).toContain("build-update-repo");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses to publish a summary when no exact appstream refs exist", () => {
    const fixture = makeSigningFixture();
    try {
      const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
      const publicKey = path.join(fixture.root, "armada-flatpak.gpg");
      const repoDir = path.join(
        fixture.root,
        "electron",
        "release",
        "flatpak-repo",
      );
      fs.writeFileSync(publicKey, "public key");
      fs.writeFileSync(fixture.bundle, "unsigned bundle");

      const result = runSigningScript(fixture, {
        FLATPAK_GPG_KEY: fingerprint,
        FLATPAK_GPG_PUBLIC_KEY: publicKey,
        MOCK_NO_APPSTREAM: "1",
        MOCK_PUBLIC_FINGERPRINTS: fingerprint,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no appstream/<arch>");
      expect(fs.readFileSync(fixture.bundle, "utf8")).toBe("unsigned bundle");
      expect(fs.existsSync(path.join(repoDir, "armada-flatpak.gpg"))).toBe(
        false,
      );
      expect(readCommandLog(fixture).map(([command]) => command)).toEqual([
        "build-sign",
        "refs",
      ]);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses a flatpak that cannot generate a summary index, before signing", () => {
    const fixture = makeSigningFixture();
    try {
      const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
      const publicKey = path.join(fixture.root, "armada-flatpak.gpg");
      fs.writeFileSync(publicKey, "public key");
      fs.writeFileSync(fixture.bundle, "unsigned bundle");

      const result = runSigningScript(fixture, {
        FLATPAK_GPG_KEY: fingerprint,
        FLATPAK_GPG_PUBLIC_KEY: publicKey,
        MOCK_NO_SUMMARY_INDEX: "1",
        MOCK_PUBLIC_FINGERPRINTS: fingerprint,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Flatpak 1.13 or newer");
      expect(fs.readFileSync(fixture.bundle, "utf8")).toBe("unsigned bundle");
      expect(readCommandLog(fixture)).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses a summary index with no signature shard", () => {
    const fixture = makeSigningFixture();
    try {
      const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
      const publicKey = path.join(fixture.root, "armada-flatpak.gpg");
      const repoDir = path.join(
        fixture.root,
        "electron",
        "release",
        "flatpak-repo",
      );
      fs.writeFileSync(publicKey, "public key");
      fs.writeFileSync(fixture.bundle, "unsigned bundle");

      const result = runSigningScript(fixture, {
        FLATPAK_GPG_KEY: fingerprint,
        FLATPAK_GPG_PUBLIC_KEY: publicKey,
        MOCK_NO_INDEX_SIG: "1",
        MOCK_PUBLIC_FINGERPRINTS: fingerprint,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no signature shard");
      // The bundle is never rebuilt and the publisher identity never appears,
      // so the previous release keeps serving until a signed one exists.
      expect(fs.readFileSync(fixture.bundle, "utf8")).toBe("unsigned bundle");
      expect(fs.existsSync(path.join(repoDir, "armada-flatpak.gpg"))).toBe(
        false,
      );
      // Stopped at the metadata pass: the missing shard is caught before any
      // bundle is built, so the previous release keeps serving.
      const attempted = readCommandLog(fixture).map(([command]) => command);
      expect(attempted.at(-1)).toBe("build-update-repo");
      expect(attempted).not.toContain("build-bundle");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

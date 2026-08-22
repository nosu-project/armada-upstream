import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const builder = loadYaml(
  fs.readFileSync(path.resolve(root, "electron/electron-builder.yml"), "utf8"),
);
// desktop.yml was merged into release.yml so one job could publish the release
// event after every build; the desktop/publish/deploy jobs kept their names.
const workflowSource = fs.readFileSync(
  path.resolve(root, ".ngit/act/workflows/release.yml"),
  "utf8",
);
const workflow = loadYaml(workflowSource);
const buildSteps = workflow.jobs.desktop.steps;
const publishSteps = workflow.jobs.publish.steps;
const deploySteps = workflow.jobs.deploy.steps;
const desktopSteps = [...buildSteps, ...publishSteps, ...deploySteps];
const namedStep = (name) => desktopSteps.find((step) => step.name === name);
const preflightStep = namedStep("Enforce signed Flatpak release configuration");
const flatpakBuildStep = namedStep("Build Flatpak bundle and repository");
const flatpakSigningStep = namedStep("Sign and verify the Flatpak repository");
const deployStep = namedStep(
  "Deploy desktop installers and update repositories",
);
const deployScript = deployStep?.run;

function shellCommands(script) {
  const commands = [];
  let pending = "";
  for (const rawLine of String(script || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const continued = line.endsWith("\\");
    const fragment = continued ? line.slice(0, -1).trimEnd() : line;
    pending = pending ? `${pending} ${fragment}` : fragment;
    if (!continued) {
      commands.push(pending);
      pending = "";
    }
  }
  return commands;
}

const deployCommands = shellCommands(deployScript);

function commandIndexes(fragment) {
  return deployCommands.flatMap((command, index) =>
    command.includes(fragment) ? [index] : []
  );
}

describe("desktop update publication", () => {
  it("embeds the filesystem-backed downloads feed in Electron packages", () => {
    expect(builder.publish).toEqual({
      provider: "generic",
      url: "https://armada.buzz/downloads/desktop",
    });
  });

  it("deploys both machine repositories beneath downloads and verifies them publicly", () => {
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e \"ssh -F $deploy_ssh_config\" --exclude='latest*.yml' \"$DEPLOY_ROOT/desktop/\" \"${TARGET}:/downloads/desktop/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e \"ssh -F $deploy_ssh_config\" --include='latest*.yml' --exclude='*' \"$DEPLOY_ROOT/desktop/\" \"${TARGET}:/downloads/desktop/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e \"ssh -F $deploy_ssh_config\" --include='/summaries/***' --exclude='/summary' --exclude='/summary.sig' --exclude='/summary.idx' --exclude='/summary.idx.sig' \"$DEPLOY_ROOT/flatpak/\" \"${TARGET}:/downloads/flatpak/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e \"ssh -F $deploy_ssh_config\" --include='/summary' --include='/summary.sig' --include='/summary.idx' --include='/summary.idx.sig' --exclude='*' \"$DEPLOY_ROOT/flatpak/\" \"${TARGET}:/downloads/flatpak/\"",
    );
    expect(deployCommands).toContain(
      "curl -fsS --retry 5 --retry-all-errors \"https://armada.buzz/downloads/desktop/$name\" -o \"$smoke/$name\"",
    );
    expect(deployCommands).toContain(
      "cmp \"$DEPLOY_ROOT/desktop/$name\" \"$smoke/$name\"",
    );
    expect(deployCommands).toContain(
      "curl -fsS --retry 5 --retry-all-errors \"https://armada.buzz/downloads/flatpak/$name\" -o \"$smoke/flatpak-$name\"",
    );
    expect(deployCommands).toContain(
      "cmp \"$DEPLOY_ROOT/flatpak/$name\" \"$smoke/flatpak-$name\"",
    );
    expect(deployCommands).toContain(
      "for name in summary summary.sig summary.idx summary.idx.sig config armada-flatpak.gpg armada-flatpak.fingerprint; do",
    );
    expect(deployCommands).toContain(
      'ostree remote add --repo="$public_verify_repo" --set=gpg-verify=true --set=gpg-verify-summary=true --gpg-import="$smoke/flatpak-armada-flatpak.gpg" armada-public https://armada.buzz/downloads/flatpak/',
    );
    expect(deployCommands).toContain(
      'ostree pull --repo="$public_verify_repo" --commit-metadata-only armada-public "$ref"',
    );
    expect(deployCommands).toContain(
      'curl -fsS --retry 5 --retry-all-errors "https://armada.buzz/downloads/flatpak/$summary_index_signature_relative" -o "$smoke/flatpak-summary-index-signature"',
    );
    expect(deployCommands).toContain(
      'cmp "$staged_summary_index_signature" "$smoke/flatpak-summary-index-signature"',
    );
    expect(deployScript).toContain(
      'mapfile -t staged_verify_refs < <(',
    );
    expect(deployScript).toContain(
      'ostree refs --repo="$DEPLOY_ROOT/flatpak"',
    );
    expect(
      deployScript.match(/for ref in "\$\{staged_verify_refs\[@\]\}"; do/g),
    ).toHaveLength(2);
    expect(deployScript).toContain(
      "awk '/^appstream2?\\/[^/]+$/ { print }'",
    );
    expect(deployScript).toContain(
      'staged_summary_index_sha=$(sha256sum',
    );
    expect(deployScript).toContain(
      'staged_summary_index_signature="$DEPLOY_ROOT/flatpak/summaries/$staged_summary_index_sha.idx.sig"',
    );
    expect(deployScript).toContain(
      "flatpak remote-ls --user --app --columns=application",
    );
    expect(deployScript).toContain(
      "flatpak update --user --appstream --noninteractive -y",
    );
    expect(deployScript).toContain("armada-public-flatpak");
  });

  it("keeps release credentials out of every application build", () => {
    const buildIndex = desktopSteps.indexOf(flatpakBuildStep);
    const macBuildIndex = desktopSteps.indexOf(
      namedStep("Cross-build macOS app bundles"),
    );
    const macSignIndex = desktopSteps.indexOf(
      namedStep("Sign and zip the macOS bundles"),
    );
    const signingIndex = desktopSteps.indexOf(flatpakSigningStep);
    const collectIndex = desktopSteps.indexOf(namedStep("Collect installers"));

    expect(flatpakBuildStep?.env).toEqual({
      FLATPAK_GPG_KEY: "",
      FLATPAK_GPG_PUBLIC_KEY: "",
    });
    expect(workflow.jobs.publish.needs).toBe("desktop");
    expect(JSON.stringify(workflow.jobs.desktop)).not.toContain(
      "secrets.FLATPAK_GPG",
    );
    expect(JSON.stringify(workflow.jobs.desktop)).not.toContain(
      "secrets.DEPLOY_SSH",
    );
    expect(
      publishSteps.some((step) => step.uses === "actions/checkout@v4"),
    ).toBe(false);
    expect(
      deploySteps.some((step) => step.uses === "actions/checkout@v4"),
    ).toBe(false);
    expect(buildIndex).toBeGreaterThan(-1);
    expect(macBuildIndex).toBeGreaterThan(buildIndex);
    expect(macSignIndex).toBeGreaterThan(macBuildIndex);
    expect(signingIndex).toBeGreaterThan(macSignIndex);
    expect(collectIndex).toBeGreaterThan(signingIndex);
    for (const buildStepName of [
      "Build standalone web bundle",
      "Build Linux + Windows installers",
      "Build Flatpak bundle and repository",
      "Cross-build macOS app bundles",
      "Sign and zip the macOS bundles",
    ]) {
      const applicationBuildIndex = desktopSteps.indexOf(
        namedStep(buildStepName),
      );
      expect(applicationBuildIndex).toBeGreaterThan(-1);
      expect(applicationBuildIndex).toBeLessThan(signingIndex);
    }
    expect(flatpakSigningStep?.env).toMatchObject({
      FLATPAK_GPG_PRIVATE_KEY_BASE64:
        "${{ secrets.FLATPAK_GPG_PRIVATE_KEY_BASE64 }}",
      FLATPAK_GPG_EXPECTED_FINGERPRINT:
        "${{ secrets.FLATPAK_GPG_EXPECTED_FINGERPRINT }}",
    });
    expect(JSON.stringify(workflow.jobs.publish)).not.toContain(
      "secrets.DEPLOY_SSH",
    );
    expect(JSON.stringify(workflow.jobs.deploy)).not.toContain(
      "FLATPAK_GPG_PRIVATE_KEY_BASE64",
    );
    expect(workflow.jobs.deploy.needs).toBe("publish");
    expect(workflow.jobs.deploy.if).toBe(
      "startsWith(github.ref, 'refs/tags/v')",
    );
    expect(preflightStep?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(flatpakSigningStep?.if).toBe(
      "startsWith(github.ref, 'refs/tags/v')",
    );
    expect(flatpakSigningStep?.run).toContain(
      'unset FLATPAK_GPG_PRIVATE_KEY_BASE64',
    );
    expect(flatpakSigningStep?.run).not.toContain("GITHUB_ENV");
    expect(flatpakSigningStep?.run).toContain(
      "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    // cat-file rather than show: a writable checkout also controls
    // .gitattributes, and show is the read path that honours textconv.
    expect(flatpakSigningStep?.run).toContain(
      'git cat-file blob "${GITHUB_SHA}:electron/flatpak/sign.sh" > "$trusted_sign_script"',
    );
    expect(flatpakSigningStep?.run).not.toContain("git show ");
    expect(flatpakSigningStep?.run).toContain(
      "export GIT_NO_REPLACE_OBJECTS=1",
    );
    expect(flatpakSigningStep?.run).toContain("sha256sum -c -");
    const signerSource = fs.readFileSync(
      path.resolve(root, "electron/flatpak/sign.sh"),
    );
    expect(flatpakSigningStep?.env?.TRUSTED_SIGN_SCRIPT_SHA256).toBe(
      createHash("sha256").update(signerSource).digest("hex"),
    );
    expect(flatpakSigningStep.run.indexOf("sha256sum -c -")).toBeLessThan(
      flatpakSigningStep.run.indexOf("--import"),
    );
    expect(flatpakSigningStep?.run).toContain(
      'ARMADA_FLATPAK_RELEASE_DIR="$PWD/electron/release"',
    );
    expect(flatpakSigningStep?.run).toContain('"$trusted_sign_script"');
    expect(flatpakSigningStep?.run).not.toContain("./flatpak/sign.sh");
    const firstPublishAction = publishSteps.findIndex((step) => step.uses);
    expect(firstPublishAction).toBeGreaterThan(
      publishSteps.indexOf(namedStep("Collect installers")),
    );
    expect(deployStep?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(deployScript).toContain(
      'DEPLOY_ROOT="$PWD/electron/release/deploy"',
    );
    expect(deployScript).not.toContain("node ");
    expect(deployScript).not.toContain("electron/scripts/");
    expect(deployScript).toContain(
      "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(deployScript).toContain(
      'deploy_ssh_dir=$(mktemp -d "$RUNNER_TEMP/armada-deploy-ssh.XXXXXX")',
    );
    expect(deployScript).toContain("trap cleanup_deploy_ssh EXIT HUP INT TERM");
    expect(deployScript).toContain("cleanup_deploy_ssh\n");
    expect(deployScript).not.toContain("mkdir -p ~/.ssh");
    expect(deployScript).not.toContain("> ~/.ssh/");
    expect(
      deploySteps
        .slice(0, deploySteps.indexOf(deployStep))
        .some((step) => step.uses || JSON.stringify(step).includes("secrets.")),
    ).toBe(false);
    expect(deploySteps.every((step) => !step.uses)).toBe(true);
    expect(
      publishSteps
        .filter((step) => step.uses)
        .every(
          (step) =>
            publishSteps.indexOf(step) >
            publishSteps.indexOf(flatpakSigningStep),
        ),
    ).toBe(true);
    expect(
      JSON.stringify(workflow.jobs.desktop).includes("secrets.DEPLOY_SSH"),
    ).toBe(false);
    expect(
      JSON.stringify(workflow.jobs.publish).includes("secrets.DEPLOY_SSH"),
    ).toBe(false);
    expect(
      JSON.stringify(workflow.jobs.deploy).includes(
        "secrets.FLATPAK_GPG_PRIVATE_KEY_BASE64",
      ),
    ).toBe(false);
    expect(namedStep("Collect installers")?.run).toContain(
      'root="$PWD/electron/release/deploy"',
    );
  });

  it("fails closed when deploy signing secrets are absent or replaced", () => {
    expect(preflightStep?.env).toMatchObject({
      FLATPAK_GPG_PRIVATE_KEY_BASE64:
        "${{ secrets.FLATPAK_GPG_PRIVATE_KEY_BASE64 }}",
      FLATPAK_GPG_EXPECTED_FINGERPRINT:
        "${{ secrets.FLATPAK_GPG_EXPECTED_FINGERPRINT }}",
    });
    expect(preflightStep?.run).toContain(
      'FLATPAK_GPG_PRIVATE_KEY_BASE64 and FLATPAK_GPG_EXPECTED_FINGERPRINT must be provisioned together.',
    );
    expect(preflightStep?.run).toContain(
      'if [ -z "${FLATPAK_GPG_PRIVATE_KEY_BASE64:-}" ]; then',
    );
    expect(preflightStep?.run).toContain(
      'if [ -z "${FLATPAK_GPG_EXPECTED_FINGERPRINT:-}" ]; then',
    );
    expect(preflightStep?.run).toContain(
      "FLATPAK_GPG_PRIVATE_KEY_BASE64 is required for release tags.",
    );
    expect(preflightStep?.run).toContain(
      "FLATPAK_GPG_EXPECTED_FINGERPRINT is required for release tags.",
    );

    const signingScript = String(flatpakSigningStep?.run || "");
    expect(signingScript).toContain(
      'Flatpak private key and expected fingerprint must be provisioned together.',
    );
    expect(signingScript).toContain(
      "Refusing to publish an unsigned Flatpak artifact from a release tag.",
    );
    expect(signingScript).toContain(
      'if [ "${#secret_fingerprints[@]}" -ne 1 ]; then',
    );
    expect(signingScript).toContain(
      'if [ -z "$expected_fingerprint" ] || [ "$fingerprint" != "$expected_fingerprint" ]; then',
    );
    expect(signingScript).toContain("--list-secret-keys");
    expect(signingScript).toContain("--detach-sign");
    expect(signingScript).toContain("--pinentry-mode loopback --passphrase ''");
    expect(signingScript).toContain(
      'FLATPAK_GPG_KEY="$fingerprint"',
    );
    expect(signingScript).toContain(
      'FLATPAK_GPG_PUBLIC_KEY="$public_key"',
    );

    expect(deployStep?.env).toMatchObject({
      FLATPAK_GPG_EXPECTED_FINGERPRINT:
        "${{ secrets.FLATPAK_GPG_EXPECTED_FINGERPRINT }}",
    });
    const requiredFiles =
      "summary summary.sig summary.idx summary.idx.sig config armada-flatpak.gpg armada-flatpak.fingerprint";
    expect(deployScript).toContain(`for name in ${requiredFiles}; do`);
    expect(deployScript).toContain(
      '[ "$staged_fingerprint" != "$expected_fingerprint" ]; then',
    );
    const stagedVerification = deployCommands.findIndex((command) =>
      command.includes(
        'ostree pull --repo="$staged_verify_repo" --commit-metadata-only',
      ),
    );
    const firstRsync = deployCommands.findIndex((command) =>
      command.startsWith("rsync "),
    );
    expect(stagedVerification).toBeGreaterThan(-1);
    expect(firstRsync).toBeGreaterThan(stagedVerification);
  });

  // The published key cannot vouch for itself: everything under
  // /downloads/flatpak/ comes from one HTTPS host. The out-of-band channel is
  // the committed announcement, which ships in the static build and is named
  // by sha256 in the nsite manifest. These two gates are what keep the halves
  // from drifting — a rotated secret whose announcement was never committed
  // must fail the tag rather than ship a key nothing independent names.
  it("refuses to sign a key the committed announcement does not name", () => {
    const signingScript = String(flatpakSigningStep?.run || "");
    // The announcement is read out of the object database, like sign.sh, and
    // for the same reason: the build job was allowed to write to this
    // checkout, so the working-tree copy is not evidence of anything. Asserted
    // as two fragments rather than one wrapped line — the YAML block scalar
    // decides where the continuation lands, and that is formatting, not
    // behaviour.
    expect(signingScript).toContain("git cat-file blob");
    expect(signingScript).toContain(
      '"${GITHUB_SHA}:public/.well-known/armada-flatpak.fingerprint"',
    );
    expect(signingScript).toContain(
      'if [ "$announced_fingerprint" != "$fingerprint" ]; then',
    );
    expect(signingScript).toContain(
      "public/.well-known/armada-flatpak.fingerprint does not announce the signing key.",
    );
    // Before the key is used for anything: the tag fails at the check, not
    // after a repository has already been signed with an unannounced key.
    expect(signingScript.indexOf("$announced_fingerprint")).toBeLessThan(
      signingScript.indexOf("--detach-sign"),
    );
    // The committed file is the one CI compares against, so it has to be a
    // full primary fingerprint rather than a short id or a stray note.
    const announced = fs.readFileSync(
      path.resolve(root, "public/.well-known/armada-flatpak.fingerprint"),
      "utf8",
    );
    expect(announced).toMatch(/^[0-9A-F]{40}\n$/);
  });

  it("refuses to deploy an nsite whose fingerprint announcement is missing", () => {
    const nsite = loadYaml(
      fs.readFileSync(
        path.resolve(root, ".ngit/act/workflows/deploy-nsite.yml"),
        "utf8",
      ),
    );
    const steps = nsite.jobs.deploy.steps;
    const announceStep = steps.find(
      (step) => step.name === "Verify the published Flatpak key fingerprint",
    );
    const publishStep = steps.find(
      (step) => step.name === "Publish to Blossom + relays",
    );
    expect(announceStep).toBeDefined();
    // After the build (the file only exists in dist afterwards) and before the
    // manifest is signed — a deploy that dropped it must not reach the relays.
    const buildIndex = steps.findIndex((step) => step.run === "npm run build");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(steps.indexOf(announceStep)).toBeGreaterThan(buildIndex);
    expect(steps.indexOf(publishStep)).toBeGreaterThan(
      steps.indexOf(announceStep),
    );
    const announceScript = String(announceStep?.run || "");
    expect(announceScript).toContain(
      "committed=public/.well-known/armada-flatpak.fingerprint",
    );
    expect(announceScript).toContain(
      "published=dist/.well-known/armada-flatpak.fingerprint",
    );
    // The manifest commits to the bytes served, so equal-after-normalization
    // is not enough.
    expect(announceScript).toContain('cmp "$committed" "$published"');
    expect(announceScript).toContain('if [ "${#value}" -ne 40 ]; then');
    expect(announceScript).toContain(
      "refusing to deploy",
    );
  });

  it("stages and verifies the pinned public Flatpak identity", () => {
    const signingScript = String(flatpakSigningStep?.run || "");
    expect(signingScript).toContain(
      'public_key="$signing_scratch/armada-flatpak.gpg"',
    );
    expect(signingScript).toContain('--export "$fingerprint"');
    expect(signingScript).not.toContain("--armor");
    expect(signingScript).toContain(
      'test -s "$flatpak_repo/summary.sig"',
    );
    expect(signingScript).toContain(
      'test -s "$flatpak_repo/summary.idx"',
    );
    expect(signingScript).toContain(
      'test -s "$flatpak_repo/summary.idx.sig"',
    );
    expect(signingScript).toContain(
      'summary_index_sha=$(sha256sum "$flatpak_repo/summary.idx" | cut -d \' \' -f1)',
    );
    expect(signingScript).toContain(
      'summary_index_signature="$flatpak_repo/summaries/$summary_index_sha.idx.sig"',
    );
    expect(signingScript).toContain(
      'test -s "$flatpak_repo/armada-flatpak.gpg"',
    );
    expect(signingScript).toContain(
      'test -s "$flatpak_repo/armada-flatpak.fingerprint"',
    );
    expect(signingScript).toContain(
      'cmp "$public_key" "$flatpak_repo/armada-flatpak.gpg"',
    );
    expect(signingScript).toContain(
      '[ "$published_fingerprint" = "$fingerprint" ]',
    );
    expect(signingScript).toContain(
      '--set=gpg-verify=true --set=gpg-verify-summary=true',
    );
    expect(signingScript).toContain(
      'ostree pull --repo="$verify_repo" --commit-metadata-only',
    );
    expect(signingScript).toContain(
      'mapfile -t verify_refs < <(',
    );
    expect(signingScript).toContain(
      'ostree refs --repo="$flatpak_repo"',
    );
    expect(signingScript).toContain(
      'for ref in "${verify_refs[@]}"; do',
    );
    expect(signingScript).toContain(
      "awk '/^appstream2?\\/[^/]+$/ { print }'",
    );
    expect(signingScript).toContain(
      "flatpak remote-ls --user --app --columns=application",
    );
    expect(signingScript).toContain(
      "flatpak update --user --appstream --noninteractive -y",
    );
    expect(signingScript).toContain(
      "flatpak install --user --no-deps --bundle --noninteractive -y",
    );
    expect(signingScript).toContain(
      "bundle_origin=$(flatpak info --user --show-origin buzz.armada.app)",
    );
    expect(signingScript).toContain(
      '[ "$bundle_url" = "https://armada.buzz/downloads/flatpak/" ]',
    );
    expect(signingScript).toContain('[ "$bundle_gpg_verify" = true ]');
    expect(signingScript).toContain('[ "$bundle_summary_verify" = true ]');
    expect(signingScript).toContain("cleanup_signing_home\n");

    const toolingScript = String(
      namedStep(
        "Install publishing tooling (fallback for stock runner images)",
      )?.run || "",
    );
    expect(toolingScript).toContain(
      "command -v gpg >/dev/null 2>&1 || packages+=(gnupg)",
    );
    expect(toolingScript).toContain(
      "command -v ostree >/dev/null 2>&1 || packages+=(ostree)",
    );
    expect(toolingScript).toContain(
      "command -v flatpak >/dev/null 2>&1 || packages+=(flatpak)",
    );
    // Whatever the signing step refuses to run without, the fallback has to be
    // able to install — including git, which it uses to read the committed
    // signer out of the object database rather than the working tree.
    const requiredCommands = signingScript
      .match(/for required_command in ([^;]+); do/)?.[1]
      .trim()
      .split(/\s+/);
    expect(requiredCommands).toContain("git");
    for (const command of requiredCommands) {
      expect(toolingScript).toContain(`command -v ${command} >/dev/null 2>&1`);
    }
    expect(
      namedStep(
        "Install publishing tooling (fallback for stock runner images)",
      )?.if,
    ).toBeUndefined();
    expect(toolingScript).toContain("refs/tags/v*)");

    // Signing and its verification run before the installers are staged, so a
    // failed release tag would otherwise upload nothing at all to inspect.
    const failureUpload = publishSteps.find(
      (step) => step.uses === "actions/upload-artifact@v4" && step.if,
    );
    expect(failureUpload?.if).toBe("failure()");
    expect(failureUpload?.with?.["if-no-files-found"]).toBe("warn");
    expect(failureUpload?.with?.path).toContain("electron/release/");
  });

  it("keeps legacy clients current and publishes mutable pointers last", () => {
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e \"ssh -F $deploy_ssh_config\" --exclude='latest*.yml' \"$DEPLOY_ROOT/desktop/\" \"${TARGET}:/desktop/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e \"ssh -F $deploy_ssh_config\" --include='latest*.yml' --exclude='*' \"$DEPLOY_ROOT/desktop/\" \"${TARGET}:/desktop/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e \"ssh -F $deploy_ssh_config\" --include='/summaries/***' --exclude='/summary' --exclude='/summary.sig' --exclude='/summary.idx' --exclude='/summary.idx.sig' \"$DEPLOY_ROOT/flatpak/\" \"${TARGET}:/flatpak/\"",
    );
    expect(deployCommands).toContain(
      "rsync -av --chmod=D755,F644 -e \"ssh -F $deploy_ssh_config\" --include='/summary' --include='/summary.sig' --include='/summary.idx' --include='/summary.idx.sig' --exclude='*' \"$DEPLOY_ROOT/flatpak/\" \"${TARGET}:/flatpak/\"",
    );

    const flatpakPayloads = commandIndexes(
      "--include='/summaries/***' --exclude='/summary' --exclude='/summary.sig' --exclude='/summary.idx' --exclude='/summary.idx.sig'",
    );
    const flatpakPointers = commandIndexes(
      "--include='/summary' --include='/summary.sig' --include='/summary.idx' --include='/summary.idx.sig'",
    );
    const electronPayloads = commandIndexes("--exclude='latest*.yml'");
    const electronPointers = commandIndexes("--include='latest*.yml'");
    expect(flatpakPayloads).toHaveLength(2);
    expect(flatpakPointers).toHaveLength(2);
    for (const index of flatpakPayloads) {
      expect(deployCommands[index]).not.toContain("--exclude='/summaries'");
      expect(deployCommands[index]).not.toContain("--exclude='summary*'");
    }
    expect(electronPayloads).toHaveLength(2);
    expect(electronPointers).toHaveLength(2);
    expect(Math.max(...flatpakPayloads)).toBeLessThan(
      Math.min(...flatpakPointers),
    );
    expect(Math.max(...electronPayloads)).toBeLessThan(
      Math.min(...electronPointers),
    );

    const publicFlatpakRefresh = deployCommands.findIndex((command) =>
      command.includes(
        "flatpak update --user --appstream --noninteractive -y armada-public-flatpak",
      ),
    );
    expect(publicFlatpakRefresh).toBeGreaterThan(
      Math.max(...flatpakPointers),
    );

    // Installers are no longer deployed at all: they are named by the
    // kind-30622 release event and fetched from Blossom by hash. Only what
    // cannot be content-addressed still goes over SSH — electron-updater's
    // fixed feed URL and the Flatpak OSTree remote.
    const installerPublish = deployCommands.filter((command) =>
      command.includes("$DEPLOY_ROOT/downloads"),
    );
    expect(installerPublish).toEqual([]);
  });

  // The .flatpak bundle configures a GPG-verified update origin when it is
  // installed, so announcing it before that origin is readable and verified
  // would hand a user an app whose first update fails. That used to be a
  // hand-ordered final rsync; it is now structural, and this is the assertion
  // that keeps it so.
  it("announces the release only after the Flatpak origin is published and verified", () => {
    expect(workflow.jobs.release.needs).toContain("deploy");
    expect(workflow.jobs.deploy.needs).toBe("publish");

    const publishStep = workflow.jobs.release.steps.find(
      (step) => step.name === "Publish the NIP-34 release event",
    );
    expect(publishStep?.run).toContain("scripts/publish-release.mjs");
  });

  // One writer, structurally. Kind 30622 is addressable and Nostr has no
  // compare-and-swap, so a second publisher would replace the first's event
  // rather than merge with it, silently dropping half the artifacts.
  it("publishes the release event from exactly one job, after every build", () => {
    const publishers = Object.entries(workflow.jobs).filter(([, job]) =>
      job.steps.some((step) => String(step.run || "").includes("publish-release.mjs")),
    );
    expect(publishers.map(([name]) => name)).toEqual(["release"]);
    expect(workflow.jobs.release.needs).toEqual(["android", "deploy"]);
  });
});

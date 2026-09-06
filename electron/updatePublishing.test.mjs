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
// event after every build. Nothing is published over SSH: the .flatpak bundle
// is signed, verified and then staged for the release event like every other
// installer, so there is no deploy job.
const workflowSource = fs.readFileSync(
  path.resolve(root, ".ngit/act/workflows/release.yml"),
  "utf8",
);
const workflow = loadYaml(workflowSource);
const buildSteps = workflow.jobs.desktop.steps;
const publishSteps = workflow.jobs.publish.steps;
const desktopSteps = [...buildSteps, ...publishSteps];
const namedStep = (name) => desktopSteps.find((step) => step.name === name);
const preflightStep = namedStep("Enforce signed Flatpak release configuration");
const flatpakBuildStep = namedStep("Build Flatpak bundle and repository");
const flatpakSigningStep = namedStep("Sign and verify the Flatpak repository");

describe("desktop update publication", () => {
  // Kept only so app-update.yml is packaged; the url is never fetched.
  // publishAutoUpdate: false stops latest*.yml being generated.
  it("embeds a publish config in Electron packages but generates no feed", () => {
    expect(builder.publish).toEqual({
      provider: "generic",
      publishAutoUpdate: false,
      url: "https://armada.buzz/downloads/desktop",
    });
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
    // Nothing leaves this job over the network: the signed bundle is staged
    // for the release event and that is the whole publication path.
    expect(workflowSource).not.toContain("rsync");
    expect(workflowSource).not.toContain("DEPLOY_SSH");
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
  });

  // The embedded key cannot vouch for itself: it travels inside the bundle it
  // signs. The out-of-band channel is the committed announcement, which ships
  // in the static build and is named by sha256 in the nsite manifest. These
  // two gates are what keep the halves from drifting — a rotated secret whose
  // announcement was never committed must fail the tag rather than ship a key
  // nothing independent names.
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

  // The nsite deploys from `main` and from nothing else. A tag push carries
  // the same commit as the `main` push beside it, so adding a tag trigger back
  // buys no bundle that isn't already published — and costs two things. act
  // derives a container name from the workflow and job names alone (no run id,
  // ref or commit), so one commit planning this workflow twice put both runs
  // on one container and each destroyed the other's. And the only reason a tag
  // ran it at all was the kind-5128 snapshot, which `nsyte snapshot` can title
  // only by retitling the LIVE site and back — the one piece of state this job
  // could strand. Restore the tag path when nsyte can title a snapshot
  // directly, in its OWN workflow file so the container names differ.
  it("deploys the nsite from main only", () => {
    const nsite = loadYaml(
      fs.readFileSync(
        path.resolve(root, ".ngit/act/workflows/deploy-nsite.yml"),
        "utf8",
      ),
    );
    expect(nsite.on.push.branches).toEqual(["main"]);
    expect(nsite.on.push.tags).toBeUndefined();
    const publishStep = nsite.jobs.deploy.steps.find(
      (step) => step.name === "Publish to Blossom + relays",
    );
    const publishScript = String(publishStep?.run || "");
    expect(publishScript).toContain("scripts/nsite-deploy.sh dist");
    expect(publishScript).not.toContain("nsyte snapshot");
    // Nothing here writes the config, so no run can leave the live site
    // titled with a version.
    expect(publishScript).not.toContain("config.title");
  });

  // nsyte runs one upload queue per Blossom server and signs the manifest only
  // after EVERY queue drains, with ~90 s of retries per file on a dead server,
  // so one broken mirror runs a deploy past its deadline and publishes nothing.
  // Every nsite deploy therefore goes through the wrapper, which probes the
  // hosts, bounds the run, retries without the server a failed run blames, and
  // deploys with --sync so a mirror that missed a deploy is backfilled by the
  // next one. A workflow calling nsyte itself would get none of that and fail
  // exactly the way this guards against. There is exactly one nsite deploy:
  // the web client, from deploy-nsite.
  it("reaches nsyte only through the probing, bounded wrapper", () => {
    const workflows = ["deploy-nsite.yml", "release.yml"].map((file) =>
      loadYaml(
        fs.readFileSync(
          path.resolve(root, ".ngit/act/workflows", file),
          "utf8",
        ),
      ),
    );
    const invocation = /(^|[\s;|&(])nsyte\s+(deploy|download|upload)\b/;
    const wrapperCalls = [];
    for (const workflow of workflows) {
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
          const lines = String(step.run || "")
            .split("\n")
            .filter((line) => !line.trim().startsWith("#"));
          for (const line of lines) {
            expect(line, `${step.name}: ${line.trim()}`).not.toMatch(invocation);
            if (/scripts\/nsite-(deploy|download)\.sh/.test(line)) {
              wrapperCalls.push(line.trim());
            }
          }
        }
      }
    }
    expect(wrapperCalls).toEqual(["scripts/nsite-deploy.sh dist"]);
    expect(fs.existsSync(path.resolve(root, "scripts/nsite-download.sh"))).toBe(false);
    expect(fs.existsSync(path.resolve(root, "scripts/verify-flatpak-origin.sh"))).toBe(false);
    // No step may reintroduce the OSTree repository fold.
    for (const file of ["deploy-nsite.yml", "release.yml"]) {
      const source = fs.readFileSync(
        path.resolve(root, ".ngit/act/workflows", file),
        "utf8",
      );
      const active = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      expect(active).not.toContain("armada-fp");
      expect(active).not.toContain("downloads/flatpak");
    }

    const deploy = fs.readFileSync(
      path.resolve(root, "scripts/nsite-deploy.sh"),
      "utf8",
    );
    expect(deploy).toContain('live-hosts.sh" "$servers"');
    expect(deploy).toContain("timeout --signal=TERM --kill-after=30");
    // The mirroring: without --sync nsyte transfers only files whose hash
    // changed since the last manifest, and a server that missed one deploy
    // stays missing those blobs forever.
    expect(deploy).toMatch(/nsyte deploy "\$dir"[\s\S]*?--sync/);
    // The failover: the servers a failed run's log blames are dropped on the
    // retry, and the retry does not silently give up the set.
    expect(deploy).toContain('blamed="$(blamed_servers "$log" "$servers_now")"');
    // A 5xx answered by a proxy in front of a dead backend is down, not alive.
    const probe = fs.readFileSync(
      path.resolve(root, "scripts/live-hosts.sh"),
      "utf8",
    );
    expect(probe).toMatch(/5\*\)\s*\n\s*echo "  drop \(HTTP \$code\)/);
  });

  // ngit-ci's ref matcher special-cases a bare `*` to true and handles a
  // `<prefix>/**` suffix, but reduces a bare `**` to `starts_with("*")` —
  // which matches no ref that exists. `branches: ["**"]` therefore ran the
  // suite on Nostr PRs and on no push at all. GitHub splits the same space
  // (`*` without a `/`, `**` with), so both patterns are needed either way.
  it("runs the test suite on pushes to every branch", () => {
    const testWorkflow = loadYaml(
      fs.readFileSync(
        path.resolve(root, ".ngit/act/workflows/test.yml"),
        "utf8",
      ),
    );
    const branches = testWorkflow.on.push.branches;
    expect(branches).toContain("*");
    expect(branches).toContain("**");
    // A tag is release.yml's; leaving `tags` unset is what excludes it, since
    // naming `branches` alone already fails a tag ref.
    expect(testWorkflow.on.push.tags).toBeUndefined();
    expect(Object.hasOwn(testWorkflow.on, "pull_request")).toBe(true);
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
    // No origin url (nothing serves a repository), but still GPG-verified.
    expect(signingScript).toContain('[ -z "$bundle_url" ]');
    expect(signingScript).not.toContain("armada.buzz/downloads/flatpak");
    expect(signingScript).toContain('[ "$bundle_gpg_verify" = true ]');
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

  // The bundle is staged for the release event only after its signature has
  // been verified, and `release` depends on the job that does both — so a
  // bundle whose repository failed verification can never be announced.
  it("announces the release only after the Flatpak bundle is signed and verified", () => {
    expect(workflow.jobs.release.needs).toContain("publish");
    expect(workflow.jobs.publish.needs).toBe("desktop");

    const publishStep = workflow.jobs.release.steps.find(
      (step) => step.name === "Publish the NIP-34 release event",
    );
    expect(publishStep?.run).toContain("scripts/publish-release.mjs");
  });

  // `if: always()` runs the job that carries it past an ancestor's failure, but
  // does not rescue the jobs downstream of it. With the Android build first, a
  // Google Play policy rejection ran `desktop` and then skipped `publish` — so
  // a complete set of installers went unsigned. The build that can be rejected
  // for reasons unrelated to its artifacts goes last, where nothing depends
  // on it.
  it("keeps the Android publish from gating the desktop release", () => {
    expect(workflow.jobs.desktop.needs).toBeUndefined();
    expect(workflow.jobs.publish.needs).toBe("desktop");
    expect(workflow.jobs.android.needs).toEqual(["publish"]);
    expect(workflow.jobs.android.if).toContain("always()");
  });

  // One writer, structurally. Kind 30622 is addressable and Nostr has no
  // compare-and-swap, so a second publisher would replace the first's event
  // rather than merge with it, silently dropping half the artifacts.
  it("publishes the release event from exactly one job, after every build", () => {
    const publishers = Object.entries(workflow.jobs).filter(([, job]) =>
      job.steps.some((step) => String(step.run || "").includes("publish-release.mjs")),
    );
    expect(publishers.map(([name]) => name)).toEqual(["release"]);
    expect(workflow.jobs.release.needs).toEqual(["android", "publish"]);
  });
});

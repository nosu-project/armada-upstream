// @vitest-environment node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  BUNDLE_ETAG,
  BUNDLE_POINTER,
  BUNDLE_SHELL_VERSION,
  commitBundle,
  contentId,
  pruneBundles,
  readBundleEtag,
  readBundleShellVersion,
  resolveDistRoot,
  versionOrdinal,
} = require("./bundleStore.js");

let workspaces = [];

afterEach(() => {
  for (const workspace of workspaces) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  workspaces = [];
});

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

/** A userData tree with a shipped (asar) dist and zero or more bundles. */
function workspace({ current, etag, shellVersion, bundles = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "armada-bundles-"));
  workspaces.push(root);

  const shipped = path.join(root, "asar", "dist");
  fs.mkdirSync(shipped, { recursive: true });
  fs.writeFileSync(path.join(shipped, "index.html"), "<!doctype html>shipped");

  const bundlesDir = path.join(root, "bundles");
  fs.mkdirSync(bundlesDir, { recursive: true });
  for (const [id, spec] of Object.entries(bundles)) {
    const dist = path.join(bundlesDir, id, "dist");
    fs.mkdirSync(dist, { recursive: true });
    if (spec?.index !== false) {
      fs.writeFileSync(path.join(dist, "index.html"), `<!doctype html>${id}`);
    }
  }
  if (current !== undefined) fs.writeFileSync(path.join(bundlesDir, BUNDLE_POINTER), current);
  if (etag !== undefined) fs.writeFileSync(path.join(bundlesDir, BUNDLE_ETAG), etag);
  if (shellVersion !== undefined) fs.writeFileSync(path.join(bundlesDir, BUNDLE_SHELL_VERSION), shellVersion);

  return { root, bundlesDir, shipped };
}

const resolve = (space) =>
  resolveDistRoot({ bundlesDir: space.bundlesDir, shippedDist: space.shipped });

describe("desktop bundle resolution", () => {
  it("serves the shipped bundle when nothing has been downloaded", () => {
    const space = workspace();
    expect(resolve(space)).toEqual({ root: space.shipped, id: null, source: "shipped" });
  });

  it("serves the bundle the pointer names", () => {
    const space = workspace({ current: ID_A, bundles: { [ID_A]: {} } });
    expect(resolve(space)).toEqual({
      root: path.join(space.bundlesDir, ID_A, "dist"),
      id: ID_A,
      source: "bundle",
    });
  });

  it("refuses a pointer that escapes the bundles directory", () => {
    // The pointer is a plain file in userData, and it decides which directory
    // backs the app://armada origin — which reaches the whole preload bridge.
    for (const current of ["../../../etc", "/etc", `${ID_A}/../../evil`, "", "not-hex"]) {
      expect(resolve(workspace({ current, bundles: { [ID_A]: {} } })).source).toBe("shipped");
    }
  });

  it("falls back when the named bundle is absent or incomplete", () => {
    expect(resolve(workspace({ current: ID_A })).source).toBe("shipped");
    expect(
      resolve(workspace({ current: ID_A, bundles: { [ID_A]: { index: false } } })).source,
    ).toBe("shipped");
  });
});

describe("shell-version-aware resolution", () => {
  const resolveAs = (space, shellVersion) =>
    resolveDistRoot({ bundlesDir: space.bundlesDir, shippedDist: space.shipped, shellVersion });

  it("serves a download made by this shell", () => {
    const space = workspace({ current: ID_A, shellVersion: "0.59.13", bundles: { [ID_A]: {} } });
    expect(resolveAs(space, "0.59.13").id).toBe(ID_A);
  });

  it("prefers the shipped bundle after the shell was upgraded past the download", () => {
    // The exact bug: `flatpak update` brought a newer shipped bundle, but a
    // stale download kept winning and the web layer lagged the shell.
    const space = workspace({ current: ID_A, shellVersion: "0.59.12", bundles: { [ID_A]: {} } });
    expect(resolveAs(space, "0.59.13").source).toBe("shipped");
  });

  it("prefers the shipped bundle for a download that predates version stamping", () => {
    // No recorded shell version: we cannot prove the download is this shell's,
    // so the shipped copy (which arrived with this shell) wins once, and the
    // updater re-pulls. Harmless self-heal on first run of the fixed shell.
    const space = workspace({ current: ID_A, bundles: { [ID_A]: {} } });
    expect(resolveAs(space, "0.59.13").source).toBe("shipped");
  });

  it("still serves a download made by a newer shell than the one now running", () => {
    // A downgrade should not happen (updates are forward-only), but if it does,
    // a download from a newer shell is not stale — keep serving it.
    const space = workspace({ current: ID_A, shellVersion: "0.59.14", bundles: { [ID_A]: {} } });
    expect(resolveAs(space, "0.59.13").id).toBe(ID_A);
  });

  it("honours the pointer unconditionally when no shell version is supplied", () => {
    // Backward compatible: an older caller that passes no shellVersion gets the
    // pre-stamp behaviour.
    const space = workspace({ current: ID_A, shellVersion: "0.1.0", bundles: { [ID_A]: {} } });
    expect(resolve(space).id).toBe(ID_A);
  });

  it("orders versions by the shared major/minor/patch scheme", () => {
    expect(versionOrdinal("0.59.13")).toBe(59_013);
    expect(versionOrdinal("1.2.3")).toBe(1_002_003);
    // A prerelease suffix is ignored; a non-version is null.
    expect(versionOrdinal("0.59.13-rc.1")).toBe(59_013);
    expect(versionOrdinal("")).toBeNull();
    expect(versionOrdinal(undefined)).toBeNull();
  });
});

describe("installing a bundle", () => {
  it("commits the pointer last, so an interrupted install is never served", () => {
    const space = workspace({ bundles: { [ID_A]: {} } });
    // Extracted but not committed: the pointer is what makes a bundle active.
    expect(resolve(space).source).toBe("shipped");

    commitBundle(space.bundlesDir, ID_A, 'W/"abc"');
    expect(resolve(space).id).toBe(ID_A);
    expect(readBundleEtag(space.bundlesDir)).toBe('W/"abc"');
  });

  it("refuses to commit something it would then refuse to serve", () => {
    const space = workspace({ bundles: { [ID_A]: { index: false } } });
    expect(() => commitBundle(space.bundlesDir, ID_A, null)).toThrow();
    expect(() => commitBundle(space.bundlesDir, "../evil", null)).toThrow(/bundle id/);
    expect(resolve(space).source).toBe("shipped");
  });

  it("clears a stale ETag when committing without one", () => {
    // A recorded ETag suppresses re-fetching. It must never outlive the bundle
    // it described, or the shell believes it already has content it does not.
    const space = workspace({ etag: 'W/"old"', bundles: { [ID_A]: {} } });
    commitBundle(space.bundlesDir, ID_A, null);
    expect(readBundleEtag(space.bundlesDir)).toBeNull();
  });

  it("records the shell version, and clears a stale one when omitted", () => {
    const space = workspace({ shellVersion: "0.59.11", bundles: { [ID_A]: {} } });
    commitBundle(space.bundlesDir, ID_A, null, "0.59.13");
    expect(readBundleShellVersion(space.bundlesDir)).toBe("0.59.13");
    // Committing without one clears it, so a stale version can't outlive the
    // bundle it described and wrongly keep it winning over a shipped copy.
    commitBundle(space.bundlesDir, ID_A, null);
    expect(readBundleShellVersion(space.bundlesDir)).toBeNull();
  });

  it("addresses a bundle by its content", () => {
    expect(contentId(Buffer.from("bundle bytes"))).toMatch(/^[0-9a-f]{32}$/);
    expect(contentId(Buffer.from("bundle bytes"))).toBe(contentId(Buffer.from("bundle bytes")));
    expect(contentId(Buffer.from("other"))).not.toBe(contentId(Buffer.from("bundle bytes")));
  });

  it("prunes superseded bundles but never the active one", () => {
    const space = workspace({ current: ID_B, bundles: { [ID_A]: {}, [ID_B]: {} } });
    pruneBundles(space.bundlesDir, ID_B);

    expect(fs.existsSync(path.join(space.bundlesDir, ID_A))).toBe(false);
    expect(fs.existsSync(path.join(space.bundlesDir, ID_B))).toBe(true);
    expect(resolve(space).id).toBe(ID_B);
    // The pointer and ETag files are not bundles.
    expect(fs.existsSync(path.join(space.bundlesDir, BUNDLE_POINTER))).toBe(true);
  });
});

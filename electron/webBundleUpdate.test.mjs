// @vitest-environment node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { extractBundle, parseTar, updateWebBundle } = require("./webBundleUpdate.js");
const {
  BUNDLE_POINTER,
  BUNDLE_SHELL_VERSION,
  contentId,
  readBundleManifestAt,
  readBundleShellVersion,
  resolveDistRoot,
  writeBundleManifestAt,
} = require("./bundleStore.js");

let workspaces = [];
afterEach(() => {
  for (const workspace of workspaces) fs.rmSync(workspace, { recursive: true, force: true });
  workspaces = [];
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armada-web-bundle-"));
  workspaces.push(dir);
  return dir;
}

/** A gzipped tar of a dist tree, built the way deploy-nsite builds it. */
function archiveOf(files, { tarArgs = [] } = {}) {
  const dir = tmp();
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  const out = path.join(tmp(), "web.tar.gz");
  const result = spawnSync("tar", ["-C", dir, "-czf", out, ...tarArgs, "."], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return fs.readFileSync(out);
}

function response(status, body, etag) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(etag ? { etag } : {}),
    arrayBuffer: async () => body,
  };
}

describe("web bundle extraction", () => {
  it("lays the archive out under <id>/dist and refuses traversal", () => {
    const archive = archiveOf({ "index.html": "<!doctype html>", "assets/a.js": "1" });
    const bundlesDir = tmp();
    const id = extractBundle({ bundlesDir, archive });
    expect(id).toBe(contentId(archive));
    expect(fs.readFileSync(path.join(bundlesDir, id, "dist", "index.html"), "utf8")).toBe("<!doctype html>");
    expect(fs.readFileSync(path.join(bundlesDir, id, "dist", "assets", "a.js"), "utf8")).toBe("1");
    const entries = parseTar(require("node:zlib").gunzipSync(archive));
    expect(entries.map((e) => e.name)).toContain("./index.html");
  });

  it("refuses links inside the archive", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "index.html"), "x");
    fs.symlinkSync("/etc/passwd", path.join(dir, "evil"));
    const out = path.join(tmp(), "web.tar.gz");
    spawnSync("tar", ["-C", dir, "-czf", out, "."]);
    expect(() => extractBundle({ bundlesDir: tmp(), archive: fs.readFileSync(out) })).toThrow(/refusing tar entry/);
  });

  it("reads long names through the GNU longname header", () => {
    const long = `${"d".repeat(60)}/${"f".repeat(60)}.js`;
    const archive = archiveOf({ "index.html": "x", [long]: "long" });
    const bundlesDir = tmp();
    const id = extractBundle({ bundlesDir, archive });
    expect(fs.readFileSync(path.join(bundlesDir, id, "dist", long), "utf8")).toBe("long");
  });
});

/** A resolved bundle (updateFeed.cjs's shape) naming `archive`. */
function bundleOf(archive, createdAt = 1_800_000_000, overrides = {}) {
  return {
    createdAt,
    sha256: createHash("sha256").update(archive).digest("hex"),
    urls: ["https://blossom.one/abc", "https://blossom.two/abc"],
    ...overrides,
  };
}

const neverFetch = async () => {
  throw new Error("fetched");
};

describe("updateWebBundle", () => {
  it("installs the named bundle, activates it and records the manifest time", async () => {
    const archive = archiveOf({ "index.html": "<!doctype html>v2" });
    const bundlesDir = tmp();
    fs.mkdirSync(bundlesDir, { recursive: true });
    fs.writeFileSync(path.join(bundlesDir, "etag"), '"stale"');
    const calls = [];
    const outcome = await updateWebBundle({
      bundlesDir,
      bundle: bundleOf(archive),
      activeId: null,
      shellVersion: "0.59.13",
      fetchImpl: async (url) => {
        calls.push(url);
        return response(200, archive);
      },
    });
    expect(outcome).toEqual({ result: "installed", id: contentId(archive) });
    expect(calls).toEqual(["https://blossom.one/abc"]);
    expect(fs.readFileSync(path.join(bundlesDir, BUNDLE_POINTER), "utf8")).toBe(contentId(archive));
    expect(fs.existsSync(path.join(bundlesDir, "etag"))).toBe(false);
    expect(readBundleManifestAt(bundlesDir)).toBe(1_800_000_000);
    expect(readBundleShellVersion(bundlesDir)).toBe("0.59.13");
    expect(
      resolveDistRoot({ bundlesDir, shippedDist: "/nope", shellVersion: "0.59.13" }).source,
    ).toBe("bundle");
    // And a later shell keeps serving its own shipped bundle over this download.
    expect(
      resolveDistRoot({ bundlesDir, shippedDist: "/nope", shellVersion: "0.59.14" }).source,
    ).toBe("shipped");
  });

  it("moves to the next server when one answers with other bytes or not at all", async () => {
    const archive = archiveOf({ "index.html": "<!doctype html>real" });
    const other = archiveOf({ "index.html": "<!doctype html>other" });
    const bundle = bundleOf(archive, 1_800_000_000, {
      urls: ["https://down.example/x", "https://wrong.example/x", "https://good.example/x"],
    });
    const outcome = await updateWebBundle({
      bundlesDir: tmp(),
      bundle,
      shellVersion: "0.59.13",
      fetchImpl: async (url) => {
        if (url.startsWith("https://down.")) return response(502, new ArrayBuffer(0));
        if (url.startsWith("https://wrong.")) return response(200, other);
        return response(200, archive);
      },
    });
    expect(outcome).toEqual({ result: "installed", id: contentId(archive) });
  });

  it("extracts nothing when no server has the named bytes", async () => {
    const archive = archiveOf({ "index.html": "<!doctype html>real" });
    const other = archiveOf({ "index.html": "<!doctype html>other" });
    const bundlesDir = tmp();
    await expect(
      updateWebBundle({
        bundlesDir,
        bundle: bundleOf(archive),
        shellVersion: "0.59.13",
        fetchImpl: async () => response(200, other),
      }),
    ).rejects.toThrow(/hash mismatch/);
    expect(fs.existsSync(path.join(bundlesDir, BUNDLE_POINTER))).toBe(false);
    expect(fs.existsSync(path.join(bundlesDir, contentId(other)))).toBe(false);
  });

  it("refuses a bundle with no usable sha256 or manifest time", async () => {
    const archive = archiveOf({ "index.html": "x" });
    await expect(
      updateWebBundle({ bundlesDir: tmp(), bundle: bundleOf(archive, 1, { sha256: "" }), fetchImpl: neverFetch }),
    ).rejects.toThrow(/no sha256/);
    await expect(
      updateWebBundle({ bundlesDir: tmp(), bundle: bundleOf(archive, 0), fetchImpl: neverFetch }),
    ).rejects.toThrow(/no manifest time/);
  });

  it("ignores a bundle named by a manifest older than the installed one", async () => {
    const archive = archiveOf({ "index.html": "older" });
    const bundlesDir = tmp();
    fs.mkdirSync(bundlesDir, { recursive: true });
    writeBundleManifestAt(bundlesDir, 1_800_000_500);
    const outcome = await updateWebBundle({
      bundlesDir,
      bundle: bundleOf(archive, 1_800_000_000),
      shellVersion: "0.59.13",
      fetchImpl: neverFetch,
    });
    expect(outcome).toEqual({ result: "unchanged" });
    expect(readBundleManifestAt(bundlesDir)).toBe(1_800_000_500);
  });

  it("re-stamps the active bundle without fetching it again", async () => {
    // The same bytes under a newer shell means the download is this shell's, so
    // it must keep winning — the stamp has to advance even on a no-op check.
    const archive = archiveOf({ "index.html": "same" });
    const bundlesDir = tmp();
    const id = extractBundle({ bundlesDir, archive });
    const marker = path.join(bundlesDir, id, "dist", "marker");
    fs.writeFileSync(marker, "kept");
    fs.writeFileSync(path.join(bundlesDir, BUNDLE_SHELL_VERSION), "0.59.12");
    const outcome = await updateWebBundle({
      bundlesDir,
      bundle: bundleOf(archive, 1_800_000_100),
      activeId: id,
      shellVersion: "0.59.13",
      fetchImpl: neverFetch,
    });
    expect(outcome).toEqual({ result: "unchanged" });
    expect(readBundleShellVersion(bundlesDir)).toBe("0.59.13");
    expect(readBundleManifestAt(bundlesDir)).toBe(1_800_000_100);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("refuses to activate a download older than the running shell", async () => {
    // A `flatpak update` can land a newer shell before the web deploy publishes
    // the matching bundle, so the site briefly serves an OLDER bundle. Fetching
    // and activating it would downgrade the web layer under the new shell.
    const changelog = "# Changelog\n\n## [0.59.12] - 2026-01-01\n\n- old\n";
    const archive = archiveOf({ "index.html": "<!doctype html>old", "CHANGELOG.md": changelog });
    const bundlesDir = tmp();
    const outcome = await updateWebBundle({
      bundlesDir,
      bundle: bundleOf(archive),
      activeId: null,
      shellVersion: "0.59.14",
      fetchImpl: async () => response(200, archive),
    });
    expect(outcome).toEqual({ result: "unchanged" });
    expect(fs.existsSync(path.join(bundlesDir, BUNDLE_POINTER))).toBe(false);
    expect(fs.existsSync(path.join(bundlesDir, contentId(archive)))).toBe(false);
  });

  it("activates a download whose own version matches the shell", async () => {
    const changelog = "# Changelog\n\n## [0.59.14] - 2026-01-01\n\n- new\n";
    const archive = archiveOf({ "index.html": "<!doctype html>new", "CHANGELOG.md": changelog });
    const outcome = await updateWebBundle({
      bundlesDir: tmp(),
      bundle: bundleOf(archive),
      activeId: null,
      shellVersion: "0.59.14",
      fetchImpl: async () => response(200, archive),
    });
    expect(outcome).toEqual({ result: "installed", id: contentId(archive) });
  });

  it("prunes the superseded bundle", async () => {
    const old = archiveOf({ "index.html": "old" });
    const fresh = archiveOf({ "index.html": "new" });
    const bundlesDir = tmp();
    const oldId = extractBundle({ bundlesDir, archive: old });
    const outcome = await updateWebBundle({
      bundlesDir,
      bundle: bundleOf(fresh),
      activeId: oldId,
      shellVersion: "0.59.13",
      fetchImpl: async () => response(200, fresh),
    });
    expect(outcome.result).toBe("installed");
    expect(fs.existsSync(path.join(bundlesDir, oldId))).toBe(false);
  });

  it("fails when every server fails, without touching the store", async () => {
    const bundlesDir = tmp();
    await expect(
      updateWebBundle({
        bundlesDir,
        bundle: bundleOf(Buffer.from("x")),
        shellVersion: "0.59.13",
        fetchImpl: async () => response(502, new ArrayBuffer(0)),
      }),
    ).rejects.toThrow(/HTTP 502/);
    expect(fs.existsSync(path.join(bundlesDir, BUNDLE_POINTER))).toBe(false);
  });
});

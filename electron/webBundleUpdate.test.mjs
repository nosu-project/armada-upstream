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
const { BUNDLE_POINTER, BUNDLE_SHELL_VERSION, contentId, readBundleShellVersion, resolveDistRoot } =
  require("./bundleStore.js");

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

/** A resolved `web` release (updateFeed.cjs's shape) naming `archive`. */
function releaseOf(archive, version = "0.60.0", overrides = {}) {
  return {
    version,
    file: {
      url: "https://blossom.example/abc",
      sha256: createHash("sha256").update(archive).digest("hex"),
      size: archive.length,
      ...overrides,
    },
  };
}

describe("updateWebBundle", () => {
  it("installs a release's bundle, activates it and drops any old ETag", async () => {
    const archive = archiveOf({ "index.html": "<!doctype html>v2" });
    const bundlesDir = tmp();
    fs.mkdirSync(bundlesDir, { recursive: true });
    fs.writeFileSync(path.join(bundlesDir, "etag"), '"stale"');
    const calls = [];
    const outcome = await updateWebBundle({
      bundlesDir,
      update: releaseOf(archive),
      activeId: null,
      shellVersion: "0.59.13",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return response(200, archive);
      },
    });
    expect(outcome).toEqual({ result: "installed", id: contentId(archive) });
    expect(calls[0].url).toBe("https://blossom.example/abc");
    expect(fs.readFileSync(path.join(bundlesDir, BUNDLE_POINTER), "utf8")).toBe(contentId(archive));
    expect(fs.existsSync(path.join(bundlesDir, "etag"))).toBe(false);
    expect(readBundleShellVersion(bundlesDir)).toBe("0.59.13");
    expect(
      resolveDistRoot({ bundlesDir, shippedDist: "/nope", shellVersion: "0.59.13" }).source,
    ).toBe("bundle");
    // And a later shell keeps serving its own shipped bundle over this download.
    expect(
      resolveDistRoot({ bundlesDir, shippedDist: "/nope", shellVersion: "0.59.14" }).source,
    ).toBe("shipped");
  });

  it("refuses bytes that do not match the release's sha256, before extracting", async () => {
    const archive = archiveOf({ "index.html": "<!doctype html>real" });
    const forged = archiveOf({ "index.html": "<!doctype html>other" });
    const bundlesDir = tmp();
    await expect(
      updateWebBundle({
        bundlesDir,
        update: releaseOf(archive),
        activeId: null,
        shellVersion: "0.59.13",
        fetchImpl: async () => response(200, forged),
      }),
    ).rejects.toThrow(/hash mismatch/);
    expect(fs.existsSync(path.join(bundlesDir, BUNDLE_POINTER))).toBe(false);
    expect(fs.existsSync(path.join(bundlesDir, contentId(forged)))).toBe(false);
  });

  it("refuses a release with no usable sha256", async () => {
    const archive = archiveOf({ "index.html": "x" });
    await expect(
      updateWebBundle({
        bundlesDir: tmp(),
        update: releaseOf(archive, "0.60.0", { sha256: "" }),
        shellVersion: "0.59.13",
        fetchImpl: async () => response(200, archive),
      }),
    ).rejects.toThrow(/no sha256/);
  });

  it("skips a release no newer than the shell without fetching", async () => {
    // The shell ships the desktop build's dist of its own version, so a release
    // at or below it has nothing to add.
    const archive = archiveOf({ "index.html": "x" });
    for (const version of ["v0.59.13", "0.59.12"]) {
      const outcome = await updateWebBundle({
        bundlesDir: tmp(),
        update: releaseOf(archive, version),
        shellVersion: "0.59.13",
        fetchImpl: async () => {
          throw new Error("fetched");
        },
      });
      expect(outcome).toEqual({ result: "unchanged" });
    }
  });

  it("re-stamps the shell version when the active bundle is unchanged, without fetching", async () => {
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
      update: releaseOf(archive, "0.60.0"),
      activeId: id,
      shellVersion: "0.59.13",
      fetchImpl: async () => {
        throw new Error("fetched");
      },
    });
    expect(outcome).toEqual({ result: "unchanged" });
    expect(readBundleShellVersion(bundlesDir)).toBe("0.59.13");
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("refuses to activate a bundle whose own CHANGELOG is older than the shell", async () => {
    const changelog = "# Changelog\n\n## [0.59.12] - 2026-01-01\n\n- old\n";
    const archive = archiveOf({ "index.html": "<!doctype html>old", "CHANGELOG.md": changelog });
    const bundlesDir = tmp();
    const outcome = await updateWebBundle({
      bundlesDir,
      update: releaseOf(archive, "0.60.0"),
      activeId: null,
      shellVersion: "0.59.14",
      fetchImpl: async () => response(200, archive),
    });
    expect(outcome).toEqual({ result: "unchanged" });
    expect(fs.existsSync(path.join(bundlesDir, BUNDLE_POINTER))).toBe(false);
    expect(fs.existsSync(path.join(bundlesDir, contentId(archive)))).toBe(false);
  });

  it("prunes the superseded bundle", async () => {
    const old = archiveOf({ "index.html": "old" });
    const fresh = archiveOf({ "index.html": "new" });
    const bundlesDir = tmp();
    const oldId = extractBundle({ bundlesDir, archive: old });
    const outcome = await updateWebBundle({
      bundlesDir,
      update: releaseOf(fresh),
      activeId: oldId,
      shellVersion: "0.59.13",
      fetchImpl: async () => response(200, fresh),
    });
    expect(outcome.result).toBe("installed");
    expect(fs.existsSync(path.join(bundlesDir, oldId))).toBe(false);
  });

  it("fails on a non-2xx answer without touching the store", async () => {
    const bundlesDir = tmp();
    await expect(
      updateWebBundle({
        bundlesDir,
        update: releaseOf(Buffer.from("x")),
        shellVersion: "0.59.13",
        fetchImpl: async () => response(502, new ArrayBuffer(0)),
      }),
    ).rejects.toThrow(/HTTP 502/);
    expect(fs.existsSync(path.join(bundlesDir, BUNDLE_POINTER))).toBe(false);
  });
});

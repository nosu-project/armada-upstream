// @vitest-environment node

import { spawnSync } from "node:child_process";
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

describe("updateWebBundle", () => {
  it("installs a new bundle, activates it and records the ETag", async () => {
    const archive = archiveOf({ "index.html": "<!doctype html>v2" });
    const bundlesDir = tmp();
    const calls = [];
    const outcome = await updateWebBundle({
      bundlesDir,
      url: "https://example.test/downloads/armada-web.tar.gz",
      activeId: null,
      etag: null,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return response(200, archive, '"e2"');
      },
    });
    expect(outcome).toEqual({ result: "installed", id: contentId(archive) });
    expect(calls[0].init.headers).toEqual({});
    expect(fs.readFileSync(path.join(bundlesDir, BUNDLE_POINTER), "utf8")).toBe(contentId(archive));
    expect(fs.readFileSync(path.join(bundlesDir, "etag"), "utf8")).toBe('"e2"');
    expect(resolveDistRoot({ bundlesDir, shippedDist: "/nope" }).source).toBe("bundle");
  });

  it("records the shell version it was downloaded under", async () => {
    const archive = archiveOf({ "index.html": "<!doctype html>v2" });
    const bundlesDir = tmp();
    await updateWebBundle({
      bundlesDir,
      url: "https://example.test/x",
      activeId: null,
      etag: null,
      shellVersion: "0.59.13",
      fetchImpl: async () => response(200, archive, '"e2"'),
    });
    expect(readBundleShellVersion(bundlesDir)).toBe("0.59.13");
    // And a later shell keeps serving its own shipped bundle over this download.
    expect(
      resolveDistRoot({ bundlesDir, shippedDist: "/nope", shellVersion: "0.59.14" }).source,
    ).toBe("shipped");
    // The same shell still serves the download.
    expect(
      resolveDistRoot({ bundlesDir, shippedDist: "/nope", shellVersion: "0.59.13" }).source,
    ).toBe("bundle");
  });

  it("re-stamps the shell version when the active bundle is unchanged", async () => {
    // The same bytes under a newer shell means the download is this shell's, so
    // it must keep winning — the stamp has to advance even on a no-op fetch.
    const archive = archiveOf({ "index.html": "same" });
    const bundlesDir = tmp();
    const id = extractBundle({ bundlesDir, archive });
    fs.writeFileSync(path.join(bundlesDir, BUNDLE_SHELL_VERSION), "0.59.12");
    const outcome = await updateWebBundle({
      bundlesDir,
      url: "https://example.test/x",
      activeId: id,
      etag: null,
      shellVersion: "0.59.13",
      fetchImpl: async () => response(200, archive, '"e3"'),
    });
    expect(outcome).toEqual({ result: "unchanged" });
    expect(readBundleShellVersion(bundlesDir)).toBe("0.59.13");
  });

  it("sends the ETag and treats 304 as unchanged", async () => {
    const outcome = await updateWebBundle({
      bundlesDir: tmp(),
      url: "https://example.test/x",
      activeId: "a".repeat(32),
      etag: '"e1"',
      fetchImpl: async (url, init) => {
        expect(init.headers).toEqual({ "If-None-Match": '"e1"' });
        return response(304, new ArrayBuffer(0));
      },
    });
    expect(outcome).toEqual({ result: "unchanged" });
  });

  it("does not reinstall the bundle that is already active", async () => {
    const archive = archiveOf({ "index.html": "same" });
    const bundlesDir = tmp();
    const id = extractBundle({ bundlesDir, archive });
    const marker = path.join(bundlesDir, id, "dist", "marker");
    fs.writeFileSync(marker, "kept");
    const outcome = await updateWebBundle({
      bundlesDir,
      url: "https://example.test/x",
      activeId: id,
      etag: null,
      fetchImpl: async () => response(200, archive, '"e3"'),
    });
    expect(outcome).toEqual({ result: "unchanged" });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("prunes the superseded bundle", async () => {
    const old = archiveOf({ "index.html": "old" });
    const fresh = archiveOf({ "index.html": "new" });
    const bundlesDir = tmp();
    const oldId = extractBundle({ bundlesDir, archive: old });
    const outcome = await updateWebBundle({
      bundlesDir,
      url: "https://example.test/x",
      activeId: oldId,
      etag: null,
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
        url: "https://example.test/x",
        fetchImpl: async () => response(502, new ArrayBuffer(0)),
      }),
    ).rejects.toThrow(/HTTP 502/);
    expect(fs.existsSync(path.join(bundlesDir, BUNDLE_POINTER))).toBe(false);
  });
});

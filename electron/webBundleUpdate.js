"use strict";

/**
 * Vesktop-style web bundle update: fetch the `dist` archive the signed site
 * manifest names, verify it against the manifest's hash, extract it into
 * userData, and switch the app:// origin to it (bundleStore.js). The shell
 * itself is never replaced — for a Flatpak nothing could replace it — so this
 * is the whole update path of that edition.
 *
 * Electron-free and fetch-injected so it runs on the Linux CI runner.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  bundleVersion,
  commitBundle,
  contentId,
  pruneBundles,
  readBundleManifestAt,
  versionOrdinal,
  writeBundleManifestAt,
} = require("./bundleStore");

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** A cap on the unpacked tar, so a gzip bomb fails the update, not the shell. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

function field(header, start, length) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
}

/** Entries of a (ustar/GNU/pax) tar, in order. */
function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = field(header, 257, 6).startsWith("ustar") ? field(header, 345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = null;
    offset += 512;
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = field(data, 0, data.length);
    } else if (type === "x") {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (match) longName = match[1];
    } else if (type !== "g") {
      entries.push({ name, type, data });
    }
  }
  return entries;
}

/** A relative path with no traversal, or null. */
function safeRelative(name) {
  const parts = name.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/**
 * Extract an archive into `<bundlesDir>/<id>/dist`. Only directories and
 * regular files; links are refused. Returns the content id.
 */
function extractBundle({ bundlesDir, archive }) {
  const id = contentId(archive);
  const dist = path.join(bundlesDir, id, "dist");
  fs.rmSync(path.join(bundlesDir, id), { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  for (const entry of parseTar(zlib.gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES }))) {
    const rel = safeRelative(entry.name);
    if (!rel) continue;
    const target = path.join(dist, rel);
    if (entry.type === "5") {
      fs.mkdirSync(target, { recursive: true });
    } else if (entry.type === "0" || entry.type === "\0") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data);
    } else {
      throw new Error(`refusing tar entry of type ${JSON.stringify(entry.type)}: ${entry.name}`);
    }
  }
  return id;
}

/**
 * Download `bundle.sha256` from the first of `bundle.urls` that serves those
 * exact bytes. A server answering with anything else is skipped like one that
 * is down, so one bad mirror costs a round-trip rather than the update.
 */
async function fetchVerified(bundle, fetchImpl) {
  let lastError = new Error("no bundle source");
  for (const url of bundle.urls) {
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`bundle fetch failed: HTTP ${response.status}`);
      const declared = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) throw new Error("bundle archive too large");
      const archive = Buffer.from(await response.arrayBuffer());
      if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("bundle archive too large");
      const actual = crypto.createHash("sha256").update(archive).digest("hex");
      if (actual !== bundle.sha256) throw new Error(`bundle archive hash mismatch from ${url}`);
      return archive;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Fetch, verify, extract and activate the bundle the site manifest names,
 * unless it is the one already active. Resolves `{ result: "unchanged" }` or
 * `{ result: "installed", id }`.
 *
 * `bundle` is `resolveWebBundle()` from updateFeed.cjs: read from a
 * signature-checked site manifest under a pinned key, so its `sha256` is the
 * signer's statement of what the bytes are, and nothing is extracted until the
 * download matches it. Its `createdAt` is recorded with the install, and a
 * bundle named by an OLDER manifest is refused, so a relay serving a stale
 * copy of the replaceable manifest cannot roll the web layer back.
 *
 * `shellVersion` is recorded alongside the activated bundle so a later shell —
 * one whose self-update brought a newer shipped bundle — can tell a download it
 * made from one an older shell made (bundleStore.resolveDistRoot). It also gates
 * activation: a bundle whose own version is older than this shell is dropped
 * rather than activated, so a site that is briefly behind the shell cannot
 * downgrade the web layer.
 */
async function updateWebBundle({ bundlesDir, bundle, activeId, shellVersion, fetchImpl = fetch }) {
  const sha256 = String(bundle?.sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("web bundle carries no sha256");
  if (!Number.isSafeInteger(bundle.createdAt) || bundle.createdAt <= 0) {
    throw new Error("web bundle carries no manifest time");
  }
  const recorded = readBundleManifestAt(bundlesDir);
  if (recorded !== null && bundle.createdAt < recorded) return { result: "unchanged" };
  fs.mkdirSync(bundlesDir, { recursive: true });
  // The content id is the first half of the archive's sha256, so the active
  // bundle is recognized without downloading it again.
  if (activeId && sha256.slice(0, 32) === activeId) {
    // Re-stamp: the same bytes under this shell means the active download is
    // this shell's, so it must keep winning over the shipped copy.
    commitBundle(bundlesDir, activeId, null, shellVersion);
    writeBundleManifestAt(bundlesDir, bundle.createdAt);
    return { result: "unchanged" };
  }
  const archive = await fetchVerified({ ...bundle, sha256 }, fetchImpl);
  const id = extractBundle({ bundlesDir, archive });
  // The site can lag the shell (a `flatpak update` lands before the matching
  // web deploy). resolveDistRoot would never serve an older bundle, so
  // committing it would only offer a restart that changes nothing.
  const shellOrdinal = versionOrdinal(shellVersion);
  const downloadedOrdinal = versionOrdinal(bundleVersion(path.join(bundlesDir, id, "dist")));
  if (shellOrdinal !== null && downloadedOrdinal !== null && downloadedOrdinal < shellOrdinal) {
    fs.rmSync(path.join(bundlesDir, id), { recursive: true, force: true });
    return { result: "unchanged" };
  }
  commitBundle(bundlesDir, id, null, shellVersion);
  writeBundleManifestAt(bundlesDir, bundle.createdAt);
  // The window is still serving `activeId` until the restart; the startup
  // prune in main.js removes it once nothing is reading from it.
  pruneBundles(bundlesDir, [id, activeId]);
  return { result: "installed", id };
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  extractBundle,
  parseTar,
  updateWebBundle,
};

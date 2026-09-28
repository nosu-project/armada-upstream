"use strict";

/**
 * Vesktop-style web bundle update: fetch the `dist` archive a release names,
 * verify it against the release event's hash, extract it into userData, and
 * switch the app:// origin to it (bundleStore.js). The shell itself is never
 * replaced — for a Flatpak nothing could replace it — so this is the whole
 * update path of that edition.
 *
 * Electron-free and fetch-injected so it runs on the Linux CI runner.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { bundleVersion, commitBundle, contentId, pruneBundles, versionOrdinal } = require("./bundleStore");

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
 * Fetch, verify, extract and activate the bundle a release names, unless this
 * shell already runs something at least as new. Resolves `{ result:
 * "unchanged" }` or `{ result: "installed", id }`.
 *
 * `update` is `resolveDesktopUpdate({ target: { platform: "web" } })` from
 * updateFeed.cjs: a signature-checked, pinned-author kind-30622 release, so
 * `update.file.sha256` is the maintainer's statement of what the bytes are. The
 * archive is checked against it BEFORE anything is extracted — it becomes the
 * app:// origin, which reaches the whole preload bridge, so TLS to whichever
 * server holds the blob is not the trust root. Nothing here takes a URL from
 * the renderer.
 *
 * `shellVersion` is recorded alongside the activated bundle so a later shell —
 * one whose self-update brought a newer shipped bundle — can tell a download it
 * made from one an older shell made (bundleStore.resolveDistRoot). It also gates
 * activation: a release no newer than this shell is skipped, since the bundle
 * the shell shipped with is that release's own `dist` or a later one.
 */
async function updateWebBundle({ bundlesDir, update, activeId, shellVersion, fetchImpl = fetch }) {
  const sha256 = String(update?.file?.sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("web bundle release carries no sha256");
  const shellOrdinal = versionOrdinal(shellVersion);
  const releaseOrdinal = versionOrdinal(String(update.version ?? "").replace(/^v/i, ""));
  if (shellOrdinal !== null && (releaseOrdinal === null || releaseOrdinal <= shellOrdinal)) {
    return { result: "unchanged" };
  }
  fs.mkdirSync(bundlesDir, { recursive: true });
  // The content id is the first half of the archive's sha256, so the active
  // bundle can be recognized without downloading it again.
  if (activeId && sha256.slice(0, 32) === activeId) {
    // Re-stamp: the same bytes under this shell means the active download is
    // this shell's, so it must keep winning over the shipped copy.
    commitBundle(bundlesDir, activeId, null, shellVersion);
    return { result: "unchanged" };
  }
  if (update.file.size > MAX_ARCHIVE_BYTES) throw new Error("bundle archive too large");
  const response = await fetchImpl(update.file.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`bundle fetch failed: HTTP ${response.status}`);
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) throw new Error("bundle archive too large");
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("bundle archive too large");
  const actual = crypto.createHash("sha256").update(archive).digest("hex");
  if (actual !== sha256) throw new Error(`bundle archive hash mismatch: expected ${sha256}, got ${actual}`);
  const id = extractBundle({ bundlesDir, archive });
  // Refuse to activate a bundle OLDER than this shell's own shipped copy, going
  // by the version the bundle itself declares. The release version was checked
  // above; this is the same rule applied to the contents, so a release whose
  // tag and CHANGELOG disagree cannot downgrade the web layer either.
  // resolveDistRoot would decline to serve it anyway, so committing here only
  // moves the pointer to a bundle nothing displays and offers a restart that
  // changes nothing; drop it instead.
  const downloadedOrdinal = versionOrdinal(bundleVersion(path.join(bundlesDir, id, "dist")));
  if (shellOrdinal !== null && downloadedOrdinal !== null && downloadedOrdinal < shellOrdinal) {
    fs.rmSync(path.join(bundlesDir, id), { recursive: true, force: true });
    return { result: "unchanged" };
  }
  commitBundle(bundlesDir, id, null, shellVersion);
  pruneBundles(bundlesDir, id);
  return { result: "installed", id };
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  extractBundle,
  parseTar,
  updateWebBundle,
};

"use strict";

/**
 * Vesktop-style web bundle update: fetch the site's `dist` archive, extract it
 * into userData, and switch the app:// origin to it (bundleStore.js). The
 * shell itself is never replaced — for a Flatpak nothing could replace it —
 * so this is the whole update path of that edition.
 *
 * Electron-free and fetch-injected so it runs on the Linux CI runner.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { commitBundle, contentId, pruneBundles } = require("./bundleStore");

/** Where a web deploy publishes its own dist as one archive. */
const WEB_BUNDLE_PATH = "/downloads/armada-web.tar.gz";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

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
  for (const entry of parseTar(zlib.gunzipSync(archive))) {
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
 * Fetch, extract and activate the bundle at `url` unless it is the one already
 * active. Resolves `{ result: "unchanged" }` or `{ result: "installed", id }`.
 */
async function updateWebBundle({ bundlesDir, url, activeId, etag, fetchImpl = fetch }) {
  const headers = etag ? { "If-None-Match": etag } : {};
  const response = await fetchImpl(url, { headers, redirect: "follow" });
  if (response.status === 304) return { result: "unchanged" };
  if (!response.ok) throw new Error(`bundle fetch failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("bundle archive too large");
  const newEtag = response.headers?.get?.("etag") || null;
  fs.mkdirSync(bundlesDir, { recursive: true });
  if (activeId && contentId(archive) === activeId) {
    commitBundle(bundlesDir, activeId, newEtag);
    return { result: "unchanged" };
  }
  const id = extractBundle({ bundlesDir, archive });
  commitBundle(bundlesDir, id, newEtag);
  pruneBundles(bundlesDir, id);
  return { result: "installed", id };
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  WEB_BUNDLE_PATH,
  extractBundle,
  parseTar,
  updateWebBundle,
};

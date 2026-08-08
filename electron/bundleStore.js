"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Where the web bundle served over app://armada comes from.
 *
 * The shell (main.js, preload.js, db.cjs, the native modules) and the web
 * bundle change on very different clocks — most releases touch only src/ — so
 * the bundle is a swappable directory in userData rather than a fixed path
 * inside the asar. The asar copy remains the floor: it is what a fresh install
 * runs before anything is downloaded, and what the shell falls back to when
 * there is nothing usable to serve.
 *
 * Bundles are content addressed: the directory name IS the digest of the
 * archive it came from. That means no version file, no manifest, and no
 * metadata to keep in step with the directory it describes — re-downloading
 * the same bytes lands in the same place, and a half-written directory is
 * simply one the pointer never named.
 *
 * Deliberately Electron-free so the rules can be tested on the Linux CI
 * runner, in the same spirit as updateSupport.js.
 */

/** The file naming the active bundle, relative to the bundles directory. */
const BUNDLE_POINTER = "current";
/** The last ETag seen for the bundle archive. */
const BUNDLE_ETAG = "etag";
const CONTENT_ID = /^[0-9a-f]{32}$/;

/** The directory name for an archive: the first half of its sha256. */
function contentId(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/**
 * Pick the dist directory to serve.
 *
 * Forward-only: there is no revert to a previous bundle. If the active one is
 * unusable the shell serves what shipped in the asar and keeps looking for a
 * newer bundle.
 */
function resolveDistRoot({ bundlesDir, shippedDist }) {
  const shipped = { root: shippedDist, id: null, source: "shipped" };

  let pointer;
  try {
    pointer = fs.readFileSync(path.join(bundlesDir, BUNDLE_POINTER), "utf8").trim();
  } catch {
    return shipped;
  }

  // The pointer is an ordinary file in userData, so it decides which directory
  // backs the app://armada origin — and that origin reaches the whole preload
  // bridge. Constrain it to the shape this code writes rather than joining
  // whatever it happens to contain.
  if (!CONTENT_ID.test(pointer)) return shipped;

  const root = path.join(bundlesDir, pointer, "dist");
  try {
    if (!fs.statSync(path.join(root, "index.html")).isFile()) return shipped;
  } catch {
    return shipped;
  }

  return { root, id: pointer, source: "bundle" };
}

/** The ETag the active bundle was downloaded with, if any. */
function readBundleEtag(bundlesDir) {
  try {
    const etag = fs.readFileSync(path.join(bundlesDir, BUNDLE_ETAG), "utf8").trim();
    return etag || null;
  } catch {
    return null;
  }
}

/**
 * Make a freshly extracted bundle the active one.
 *
 * The pointer is written LAST and is the only commit: an interrupted download
 * or extraction leaves a directory nothing refers to, never a half-installed
 * bundle being served. The ETag follows the pointer for the same reason —
 * recording it early would suppress a re-fetch of a bundle that never landed.
 */
function commitBundle(bundlesDir, id, etag) {
  if (!CONTENT_ID.test(id)) throw new Error(`refusing to commit bundle id: ${id}`);
  if (!fs.statSync(path.join(bundlesDir, id, "dist", "index.html")).isFile()) {
    throw new Error("refusing to commit a bundle with no index.html");
  }
  fs.writeFileSync(path.join(bundlesDir, BUNDLE_POINTER), id);
  if (etag) fs.writeFileSync(path.join(bundlesDir, BUNDLE_ETAG), etag);
  else fs.rmSync(path.join(bundlesDir, BUNDLE_ETAG), { force: true });
}

/** Remove every bundle except the active one. */
function pruneBundles(bundlesDir, keepId) {
  let entries;
  try {
    entries = fs.readdirSync(bundlesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepId) continue;
    if (!CONTENT_ID.test(entry.name)) continue;
    fs.rmSync(path.join(bundlesDir, entry.name), { recursive: true, force: true });
  }
}

module.exports = {
  BUNDLE_ETAG,
  BUNDLE_POINTER,
  commitBundle,
  contentId,
  pruneBundles,
  readBundleEtag,
  resolveDistRoot,
};

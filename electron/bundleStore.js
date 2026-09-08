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
/**
 * The shell version that was running when the active bundle was downloaded.
 *
 * A downloaded bundle should win over the one baked into the shell only while
 * it is at least as new as that shipped copy. The bundle carries no version of
 * its own (it is content addressed), but the shell that fetched it does, and a
 * downloaded bundle can only be newer than a given shell's shipped bundle if it
 * was fetched by that shell or a later one. Recording the shell version at
 * download time is what lets a later shell — one whose `flatpak update` (or
 * AppImage/NSIS self-update) just brought a newer shipped bundle — recognize a
 * stale download and fall back to its own, rather than serving month-old web
 * assets under a freshly upgraded shell.
 */
const BUNDLE_SHELL_VERSION = "shell-version";
const CONTENT_ID = /^[0-9a-f]{32}$/;

/** The directory name for an archive: the first half of its sha256. */
function contentId(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/**
 * A `major*1e6 + minor*1e3 + patch` ordinal for an `X.Y.Z` version, or null
 * when it does not parse. The same scheme the Android/iOS builds use, so the
 * ordering matches everywhere; any prerelease suffix is ignored, which is safe
 * here because this only decides whether the shell was upgraded, never which
 * exact build to install.
 */
function versionOrdinal(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  if (!match) return null;
  return Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]);
}

/** The shell version the active bundle was downloaded under, if recorded. */
function readBundleShellVersion(bundlesDir) {
  try {
    const value = fs.readFileSync(path.join(bundlesDir, BUNDLE_SHELL_VERSION), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Pick the dist directory to serve.
 *
 * Forward-only: there is no revert to a previous bundle. If the active one is
 * unusable the shell serves what shipped in the asar and keeps looking for a
 * newer bundle.
 *
 * When a `shellVersion` is given, a downloaded bundle is served only if it was
 * fetched by this shell or a newer one. If the shell has been upgraded since
 * the download (or the download predates version stamping), the shipped bundle
 * that arrived WITH this shell is at least as new, so it is served instead and
 * the updater re-pulls whatever the site now has. Without a `shellVersion` the
 * pointer is honoured unconditionally, which is the old behaviour.
 */
function resolveDistRoot({ bundlesDir, shippedDist, shellVersion }) {
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

  // A shell that has moved on from the version that downloaded this bundle
  // carries a shipped bundle at least as new; serve that and let the updater
  // catch up. A download with no recorded shell version predates this stamping
  // and is treated the same way — its one-time re-pull is harmless.
  const current = versionOrdinal(shellVersion);
  if (current !== null) {
    const downloadedUnder = versionOrdinal(readBundleShellVersion(bundlesDir));
    if (downloadedUnder === null || downloadedUnder < current) return shipped;
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
 * bundle being served. The ETag and the shell version follow the pointer for
 * the same reason — recording them early would describe a bundle that never
 * landed. The shell version is the one running now: a bundle downloaded under a
 * later shell is what {@link resolveDistRoot} uses to keep serving a download
 * over the shell's own shipped copy.
 */
function commitBundle(bundlesDir, id, etag, shellVersion) {
  if (!CONTENT_ID.test(id)) throw new Error(`refusing to commit bundle id: ${id}`);
  if (!fs.statSync(path.join(bundlesDir, id, "dist", "index.html")).isFile()) {
    throw new Error("refusing to commit a bundle with no index.html");
  }
  fs.writeFileSync(path.join(bundlesDir, BUNDLE_POINTER), id);
  if (etag) fs.writeFileSync(path.join(bundlesDir, BUNDLE_ETAG), etag);
  else fs.rmSync(path.join(bundlesDir, BUNDLE_ETAG), { force: true });
  if (shellVersion) fs.writeFileSync(path.join(bundlesDir, BUNDLE_SHELL_VERSION), String(shellVersion));
  else fs.rmSync(path.join(bundlesDir, BUNDLE_SHELL_VERSION), { force: true });
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
  BUNDLE_SHELL_VERSION,
  commitBundle,
  contentId,
  pruneBundles,
  readBundleEtag,
  readBundleShellVersion,
  resolveDistRoot,
  versionOrdinal,
};

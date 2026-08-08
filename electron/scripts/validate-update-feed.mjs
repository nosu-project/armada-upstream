#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { load as loadYaml } from "js-yaml";

/**
 * A blockmap is a differential-download aid, not an installer. electron-updater
 * fetches it to plan a delta and then verifies the ASSEMBLED file against the
 * installer's own digest, so a feed that lists one without a checksum is still
 * sound. Every other reference is something a client will execute.
 */
const DIGEST_EXEMPT = /\.blockmap$/;

export function updateFeedReferences(document) {
  const references = new Set();
  if (typeof document?.path === "string") references.add(document.path);
  if (Array.isArray(document?.files)) {
    for (const file of document.files) {
      if (typeof file?.url === "string") references.add(file.url);
    }
  }
  return [...references];
}

/** Resolve a feed reference to a file beside the feed, or explain why not. */
function resolvePayload(feedPath, directory, reference) {
  const unsafe = () => new Error(
    `${feedPath} contains an unsafe payload path: ${reference}`,
  );
  const base = "https://armada.invalid/";
  let url;
  try {
    url = new URL(reference, base);
  } catch {
    throw unsafe();
  }
  // A reference is a path relative to the feed. An absolute URL would let a
  // feed keep a foreign host in the payload it ships to clients while these
  // checks validated the same-named file sitting in the deploy directory.
  if (url.origin !== new URL(base).origin) {
    throw new Error(`${feedPath} payload URLs must be relative: ${reference}`);
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw unsafe();
  }
  const payload = path.resolve(directory, pathname);
  // `new URL` clamps a literal ../ at the root, but a percent-encoded one
  // survives into pathname and only becomes ../ on decode. This catches that.
  if (!payload.startsWith(`${directory}${path.sep}`)) throw unsafe();
  if (!fs.statSync(payload, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${feedPath} refers to missing payload: ${reference}`);
  }
  return payload;
}

function digestOf(payload) {
  return crypto.createHash("sha512").update(fs.readFileSync(payload)).digest("base64");
}

/**
 * Verify a published updater feed against the payloads sitting beside it.
 *
 * Every check here is a REQUIREMENT, not a "verify it if present". The earlier
 * shape — `if (typeof file.sha512 === "string")` — meant a feed that simply
 * omitted the field validated clean, which is the one case the gate exists to
 * catch: nothing else stands between the feed and an auto-installing client.
 */
export function validateUpdateFeed(feedPath, { expectedVersion = null } = {}) {
  const absoluteFeed = path.resolve(feedPath);
  const directory = path.dirname(absoluteFeed);
  const document = loadYaml(fs.readFileSync(absoluteFeed, "utf8"));

  const version = typeof document?.version === "string" ? document.version.trim() : "";
  if (!version) throw new Error(`${feedPath} names no version`);
  if (expectedVersion && version !== expectedVersion) {
    throw new Error(
      `${feedPath} was built for version ${version}, not ${expectedVersion}`,
    );
  }

  const references = updateFeedReferences(document);
  if (references.length === 0) {
    throw new Error(`${feedPath} names no updater payloads`);
  }

  const payloads = new Map();
  for (const reference of references) {
    payloads.set(reference, resolvePayload(feedPath, directory, reference));
  }

  for (const file of document.files || []) {
    if (typeof file?.url !== "string") continue;
    const payload = payloads.get(file.url);
    if (!payload) continue;
    if (DIGEST_EXEMPT.test(file.url)) continue;

    if (!Number.isSafeInteger(file.size)) {
      throw new Error(`${feedPath} declares no size for payload: ${file.url}`);
    }
    if (fs.statSync(payload).size !== file.size) {
      throw new Error(`${feedPath} has a stale size for payload: ${file.url}`);
    }
    if (typeof file.sha512 !== "string" || !file.sha512) {
      throw new Error(`${feedPath} declares no sha512 for payload: ${file.url}`);
    }
    if (digestOf(payload) !== file.sha512) {
      throw new Error(`${feedPath} has a stale checksum for payload: ${file.url}`);
    }
  }

  // Clients predating the files[] array read the top-level pair, so a feed that
  // verifies through files[] can still hand an older client an unchecked file.
  if (typeof document.path === "string" && !DIGEST_EXEMPT.test(document.path)) {
    if (typeof document.sha512 !== "string" || !document.sha512) {
      throw new Error(`${feedPath} declares no sha512 for path: ${document.path}`);
    }
    if (digestOf(payloads.get(document.path)) !== document.sha512) {
      throw new Error(`${feedPath} has a stale checksum for path: ${document.path}`);
    }
  }

  return references;
}

const invokedPath = process.argv[1]
  // import.meta.url is a realpath; process.argv[1] is not resolved through
  // symlinks, so comparing them raw can silently validate nothing.
  ? pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href
  : "";
if (import.meta.url === invokedPath) {
  const args = process.argv.slice(2);
  let expectedVersion = null;
  const feeds = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--version") {
      expectedVersion = args[index + 1] ?? null;
      index += 1;
    } else {
      feeds.push(args[index]);
    }
  }
  if (feeds.length === 0) {
    console.error("Usage: validate-update-feed.mjs [--version X.Y.Z] path/to/latest.yml [...]");
    process.exitCode = 2;
  } else {
    for (const feed of feeds) {
      const references = validateUpdateFeed(feed, { expectedVersion });
      console.log(`${feed}: ${references.join(", ")}`);
    }
  }
}

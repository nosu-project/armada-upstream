#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { load as loadYaml } from "js-yaml";

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

export function validateUpdateFeed(feedPath) {
  const absoluteFeed = path.resolve(feedPath);
  const directory = path.dirname(absoluteFeed);
  const document = loadYaml(fs.readFileSync(absoluteFeed, "utf8"));
  const references = updateFeedReferences(document);
  if (references.length === 0) {
    throw new Error(`${feedPath} names no updater payloads`);
  }

  const payloads = new Map();
  for (const reference of references) {
    const pathname = decodeURIComponent(
      new URL(reference, "https://armada.invalid/").pathname.replace(/^\//, ""),
    );
    const payload = path.resolve(directory, pathname);
    if (!payload.startsWith(`${directory}${path.sep}`)) {
      throw new Error(`${feedPath} contains an unsafe payload path: ${reference}`);
    }
    if (!fs.statSync(payload, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${feedPath} refers to missing payload: ${reference}`);
    }
    payloads.set(reference, payload);
  }

  for (const file of document.files || []) {
    if (typeof file?.url !== "string") continue;
    const payload = payloads.get(file.url);
    if (!payload) continue;
    if (Number.isSafeInteger(file.size) && fs.statSync(payload).size !== file.size) {
      throw new Error(`${feedPath} has a stale size for payload: ${file.url}`);
    }
    if (typeof file.sha512 === "string") {
      const digest = crypto
        .createHash("sha512")
        .update(fs.readFileSync(payload))
        .digest("base64");
      if (digest !== file.sha512) {
        throw new Error(`${feedPath} has a stale checksum for payload: ${file.url}`);
      }
    }
  }

  return references;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const feeds = process.argv.slice(2);
  if (feeds.length === 0) {
    console.error("Usage: validate-update-feed.mjs path/to/latest.yml [...]");
    process.exitCode = 2;
  } else {
    for (const feed of feeds) {
      const references = validateUpdateFeed(feed);
      console.log(`${feed}: ${references.join(", ")}`);
    }
  }
}

import { bytesToHex } from "@noble/hashes/utils.js";

import { BLOSSOM_SHA256_PATH_REGEX } from "@/lib/blossom";
import { probeImage } from "@/lib/imageProbe";
import { mediaSrc, type MediaPolicy } from "@/lib/mediaPolicy";
import { imetaTagFromUpload, imetaUrl, profileImetaTags } from "@/lib/profileImeta";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";

/** Largest image downloaded to describe it. Profile images are rarely near this. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** How long a save waits on the downloads before publishing without them. */
const TIMEOUT_MS = 10_000;

type ProfileImages = { picture?: unknown; banner?: unknown };

/**
 * Download an image and describe it as an `imeta` tag (`m`, `x`, `size`, `dim`,
 * `blurhash`), fetched through the media policy like any other load of it.
 * Undefined when it can't be fetched, is too big, or doesn't decode — which is
 * also what ciphertext whose key was lost looks like — or when a
 * content-addressed URL's hash disagrees with the bytes (a re-encoding proxy).
 */
export async function describeImageUrl(
  url: string,
  policy: MediaPolicy,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  if (!sanitizeImageSrc(url)) return undefined;
  const src = mediaSrc(url, policy);
  if (!src) return undefined;
  try {
    const res = await fetch(src, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok || Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) return undefined;
    const blob = await res.blob();
    if (blob.size > MAX_IMAGE_BYTES) return undefined;

    const { dim, blurhash } = await probeImage(blob);
    if (!dim) return undefined;

    const x = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())));
    const path = new URL(url).pathname;
    if (BLOSSOM_SHA256_PATH_REGEX.test(path) && path.slice(1, 65).toLowerCase() !== x) return undefined;

    // Some servers send `application/octet-stream`; leave `m` out rather than repeat that.
    const mime = blob.type.split(";")[0].trim().toLowerCase();
    return imetaTagFromUpload([
      ["url", url],
      ["m", mime.startsWith("image/") ? mime : ""],
      ["x", x],
      ["size", String(blob.size)],
      ["dim", dim],
      ["blurhash", blurhash ?? ""],
    ]);
  } catch {
    return undefined;
  }
}

/**
 * {@link profileImetaTags}, plus a tag computed by downloading any `picture` or
 * `banner` none of `candidates` describes (NIP-92 "Profile metadata"), so a
 * profile set up before imeta, or by a client that doesn't write it, gains it
 * on its next save. Never throws, and never holds a save up past
 * {@link TIMEOUT_MS}: an image not described in time is published without one.
 */
export async function completeProfileImetaTags(
  metadata: ProfileImages,
  candidates: readonly string[][],
  policy: MediaPolicy,
): Promise<string[][]> {
  const tags = profileImetaTags(metadata, candidates);
  const described = new Set(tags.map(imetaUrl));
  const missing = new Set<string>();
  for (const value of [metadata.picture, metadata.banner]) {
    if (typeof value === "string" && value && !described.has(value)) missing.add(value);
  }
  if (!missing.size) return tags;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Aborting stops the downloads; the race also cuts off a slow decode.
    const computed: (string[] | undefined)[] = await Promise.race([
      Promise.all([...missing].map((url) => describeImageUrl(url, policy, controller.signal))),
      new Promise<undefined[]>((resolve) => controller.signal.addEventListener("abort", () => resolve([]))),
    ]);
    const found = computed.filter((tag): tag is string[] => !!tag);
    // Re-run the matcher so the tags come out in field order, one per image.
    return found.length ? profileImetaTags(metadata, [...tags, ...found]) : tags;
  } finally {
    clearTimeout(timer);
  }
}

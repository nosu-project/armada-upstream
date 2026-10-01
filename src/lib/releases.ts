/** Reads NIP-34 repository releases (kind 30622; see `docs/releases.md`) for `/downloads`. */

import type { DownloadOs } from "./downloads";
import { config } from "./env";
import { normalizeRelayUrl } from "./platform";

/** See docs/releases.md. */
export const RELEASE_KIND = 30622;

/**
 * Relays releases are read from — explicit because `/downloads` works signed
 * out. Discovery only (never pooled or subscribed). Must match `DEFAULT_RELAYS`
 * in `scripts/publish-release.mjs`. `relay.ngit.dev` is excluded: it rejects
 * release events.
 */
export const RELEASE_RELAYS: string[] = (
  config("RELEASE_RELAYS") ??
  "wss://relay.ditto.pub,wss://relay.dreamith.to,wss://relay.primal.net"
)
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/** Repository id (`d` of the 30617 announcement, `D` of each release). Overridable for forks. */
export const RELEASE_REPO_ID: string = config("RELEASE_REPO_ID") || "armada";

/**
 * Trusted release signers (hex). Build-time, NOT the announcement's mutable
 * `maintainers` tag: this page hands out executables, so adding a signer must
 * go through code review.
 */
export const RELEASE_AUTHORS: string[] = (
  config("RELEASE_AUTHORS") ||
  "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5"
)
  .split(",")
  .map((pubkey: string) => pubkey.trim().toLowerCase())
  .filter((pubkey: string) => /^[0-9a-f]{64}$/.test(pubkey));

/** One build output of a release. */
export interface ReleaseArtifact {
  /** Blossom URL (the path carries the hash). */
  url: string;
  hash: string;
  mime: string;
  size: number;
  platform: string;
  filename: string;
  label: string;
  os: DownloadOs | undefined;
}

export interface Release {
  id: string;
  pubkey: string;
  createdAt: number;
  repoId: string;
  version: string;
  title: string;
  channel: string;
  commit: string | undefined;
  notes: string;
  artifacts: ReleaseArtifact[];
}

/** A minimal event shape, so this module doesn't depend on a relay library. */
interface ReleaseEventLike {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}

function firstTag(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name && typeof tag[1] === "string")?.[1];
}

/**
 * Parse an `artifact` tag's `key value` fields, splitting on the FIRST space
 * (values like `alt` contain spaces). First occurrence wins, as for imeta.
 */
function parseFields(tag: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const entry of tag.slice(1)) {
    if (typeof entry !== "string") continue;
    const space = entry.indexOf(" ");
    if (space <= 0) continue;
    const key = entry.slice(0, space);
    if (!fields.has(key)) fields.set(key, entry.slice(space + 1));
  }
  return fields;
}

/**
 * Which OS card an artifact belongs on. `f` is advisory: unknown tokens fall
 * through to the filename; unplaceable artifacts are still listed.
 */
export function artifactOs(platform: string, filename: string): DownloadOs | undefined {
  const f = platform.toLowerCase();
  if (f.startsWith("linux")) return "linux";
  if (f.startsWith("windows") || f.startsWith("win")) return "windows";
  if (f.startsWith("darwin") || f.startsWith("macos") || f.startsWith("mac")) return "macos";
  if (f.startsWith("android")) return "android";
  if (f.startsWith("ios")) return "ios";

  const name = filename.toLowerCase();
  if (/\.(appimage|deb|flatpak|rpm|tar\.gz)$/.test(name)) return "linux";
  if (/\.(exe|msi)$/.test(name)) return "windows";
  if (/\.(dmg|pkg)$/.test(name) || /mac|darwin|osx/.test(name)) return "macos";
  if (/\.(apk|aab)$/.test(name)) return "android";
  if (/\.ipa$/.test(name)) return "ios";
  return undefined;
}

/** Parse a release, or undefined. Refuses events with no version or no parseable artifacts. */
export function parseRelease(event: ReleaseEventLike): Release | undefined {
  if (event.kind !== RELEASE_KIND) return undefined;

  const d = firstTag(event.tags, "d") ?? "";
  // `d` is `<repo-id>@<version>`, split on the LAST `@`; `D` wins when present.
  const at = d.lastIndexOf("@");
  const repoId = firstTag(event.tags, "D") ?? (at > 0 ? d.slice(0, at) : "");
  const version = firstTag(event.tags, "version") ?? (at > 0 ? d.slice(at + 1) : "");
  if (!repoId || !version) return undefined;

  const artifacts: ReleaseArtifact[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "artifact") continue;
    const fields = parseFields(tag);
    const url = fields.get("url");
    const hash = fields.get("x") ?? "";
    const filename = fields.get("filename") ?? "";
    if (!url || !filename) continue;

    const platform = fields.get("f") ?? "";
    const size = Number(fields.get("size"));
    artifacts.push({
      url,
      hash,
      mime: fields.get("m") ?? "application/octet-stream",
      size: Number.isFinite(size) && size > 0 ? size : 0,
      platform,
      filename,
      label: fields.get("alt") || filename,
      os: artifactOs(platform, filename),
    });
  }
  if (artifacts.length === 0) return undefined;

  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    repoId,
    version,
    title: firstTag(event.tags, "title") || version,
    channel: firstTag(event.tags, "c") || "main",
    commit: firstTag(event.tags, "commit"),
    notes: event.content,
    artifacts,
  };
}

/** Newest-first numeric comparison (v0.9.0 < v0.55.3); a prerelease loses to the same numbers without one. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, ...rest] = v.replace(/^v/, "").split("-");
    return {
      parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.join("-"),
    };
  };
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < len; i++) {
    const diff = (right.parts[i] ?? 0) - (left.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return -1;
  if (!right.pre) return 1;
  return left.pre < right.pre ? 1 : -1;
}

/**
 * The default release: newest STABLE (a prerelease sorts above the previous
 * stable), else newest of any channel.
 */
export function featuredRelease(releases: readonly Release[]): Release | undefined {
  return releases.find((release) => release.channel === "main") ?? releases[0];
}

/** Newest first, one per version (newest `created_at` wins, like NIP-34 Status). */
export function foldReleases(releases: Release[]): Release[] {
  const byVersion = new Map<string, Release>();
  for (const release of releases) {
    const existing = byVersion.get(release.version);
    if (!existing || release.createdAt > existing.createdAt) byVersion.set(release.version, release);
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version));
}

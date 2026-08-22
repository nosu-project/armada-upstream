/**
 * Reading NIP-34 repository releases (kind 30622) off the relays.
 *
 * The event shape, and why it is a new kind rather than NIP-51's 30063, are in
 * `docs/releases.md`. This is the read side: parse an event into something
 * `/downloads` can render, and decide which OS each artifact belongs to.
 */

import type { DownloadOs } from "./downloads";
import { normalizeRelayUrl } from "./platform";

/** See docs/releases.md. */
export const RELEASE_KIND = 30622;

/**
 * Where releases are read from.
 *
 * Named explicitly rather than taken from the user's pool, because `/downloads`
 * is a signed-out page: a first-time visitor has configured no relays at all,
 * and a downloads page that only works once you have an account is not a
 * downloads page. This is discovery config in the same shape as
 * `GIT_ANNOUNCEMENT_DISCOVERY_RELAY` — dialled when this page asks a question,
 * never added to the pool, never subscribed to — and not the build-time relay
 * pin the client deliberately doesn't have, which would dial on boot.
 *
 * The defaults are the repository's own relays (its kind-30617 `relays` tag)
 * plus the general ones the release is broadcast to.
 */
export const RELEASE_RELAYS: string[] = (
  import.meta.env.VITE_RELEASE_RELAYS ??
  "wss://relay.ngit.dev,wss://relay.ditto.pub,wss://relay.dreamith.to,wss://relay.primal.net"
)
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/**
 * The repository whose releases this build offers.
 *
 * Matches the `d` of the kind-30617 announcement, and so the `D` tag of every
 * release. Overridable so a fork can point its own build at its own releases
 * without patching source.
 */
export const RELEASE_REPO_ID: string = import.meta.env.VITE_RELEASE_REPO_ID || "armada";

/**
 * Whose releases to trust, as hex pubkeys.
 *
 * Deliberately a BUILD-TIME constant rather than the `maintainers` tag of the
 * live announcement. NIP-34 resolves most repo events against the current
 * maintainer set, but this page hands people executables: making the trust root
 * a mutable event means anyone who ever lands in that tag can publish binaries
 * the download page presents as Armada. Pinning it here makes adding a release
 * signer a code change that ships through review.
 */
export const RELEASE_AUTHORS: string[] = (
  import.meta.env.VITE_RELEASE_AUTHORS ||
  "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5"
)
  .split(",")
  .map((pubkey: string) => pubkey.trim().toLowerCase())
  .filter((pubkey: string) => /^[0-9a-f]{64}$/.test(pubkey));

/** One build output of a release. */
export interface ReleaseArtifact {
  /** Where the bytes are. Blossom, so the path carries the hash. */
  url: string;
  /** sha256 of the file, hex. */
  hash: string;
  mime: string;
  size: number;
  /** The `f` token as published, e.g. `linux-x86_64`. */
  platform: string;
  filename: string;
  /** Human label from `alt`, e.g. "Linux AppImage (x86_64)". */
  label: string;
  /** Which card this belongs on, resolved from {@link artifactOs}. */
  os: DownloadOs | undefined;
}

export interface Release {
  id: string;
  pubkey: string;
  createdAt: number;
  /** The repo id from `D` — matches `30617:<pubkey>:<repoId>`. */
  repoId: string;
  /** As spelled in the git tag, e.g. `v1.2.3`. */
  version: string;
  title: string;
  /** `main` for stable, `rc` for a prerelease. */
  channel: string;
  commit: string | undefined;
  /** Markdown release notes. */
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
 * Parse the space-delimited `key value` pairs of an `artifact` tag.
 *
 * Split on the FIRST space only: `alt Linux AppImage (x86_64)` is one field
 * whose value contains spaces, and splitting on every space would truncate
 * every human label to its first word. Repeated keys keep the first occurrence,
 * matching how NIP-92 parsers treat imeta.
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
 * Which platform card an artifact belongs on.
 *
 * `f` leads but is treated as ADVISORY, per docs/releases.md: the published
 * vocabulary is thin and inconsistent across publishers, so a token this build
 * doesn't recognize falls through to the filename rather than dropping the
 * download. An unplaceable artifact returns undefined and is still listed — it
 * just doesn't get filed under an OS.
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

/**
 * Turn an event into a {@link Release}, or undefined if it isn't one.
 *
 * Refuses rather than repairs: a release with no version can't be labelled or
 * ordered, and one whose artifacts all failed to parse would render as a
 * version with no downloads, which is worse than not offering it.
 */
export function parseRelease(event: ReleaseEventLike): Release | undefined {
  if (event.kind !== RELEASE_KIND) return undefined;

  const d = firstTag(event.tags, "d") ?? "";
  // `d` is `<repo-id>@<version>`, split on the LAST `@` so a repo id that
  // itself contains one still resolves. `D` is authoritative when present;
  // the split is the fallback for an event that omitted it.
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

/**
 * Compare two version tags, newest first.
 *
 * Numeric segment by segment rather than lexically, or v0.9.0 would sort above
 * v0.55.3. A tag carrying a prerelease suffix loses to the same numbers without
 * one, so v1.2.3 outranks v1.2.3-rc.1.
 */
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
 * The release `/downloads` should offer by default.
 *
 * The newest STABLE one, not simply the newest: a prerelease sorts above the
 * stable version it precedes (v1.2.3-rc.1 is newer than v1.2.2), so featuring
 * the head of the list would hand every visitor a release candidate the moment
 * one is tagged. Prereleases stay visible in the earlier-releases list, where
 * their channel is labelled.
 *
 * Falls back to the newest of any channel, so a repository that has only ever
 * tagged prereleases still offers something rather than looking empty.
 */
export function featuredRelease(releases: readonly Release[]): Release | undefined {
  return releases.find((release) => release.channel === "main") ?? releases[0];
}

/**
 * Newest first, keeping one release per version.
 *
 * A version can legitimately arrive more than once — the same maintainer
 * republishing to correct an artifact, or two trusted signers publishing the
 * same tag — so the newest `created_at` wins, matching how NIP-34 resolves
 * competing Status events.
 */
export function foldReleases(releases: Release[]): Release[] {
  const byVersion = new Map<string, Release>();
  for (const release of releases) {
    const existing = byVersion.get(release.version);
    if (!existing || release.createdAt > existing.createdAt) byVersion.set(release.version, release);
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version));
}

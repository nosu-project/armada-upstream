/**
 * The desktop shell's update feed: the kind-30622 release event, narrowed to
 * the one installer this machine can install.
 *
 * `/downloads` and the Electron updater now read the SAME event. They used to
 * read different things — the page read the event while electron-updater
 * fetched `latest*.yml` from `armada.buzz/downloads/desktop` — and the cost of
 * that split was not the duplication but the asymmetry: the page's artifacts
 * were content-addressed and signed by a pinned maintainer key, while the
 * updater's were whatever the web server happened to be serving under a mutable
 * name. The updater is the half that executes what it downloads, so it was the
 * half with the weaker guarantee. Reading the event gives it the stronger one
 * and removes a second place a release has to be published to.
 *
 * This file is ordinary `src/` TypeScript, bundled into `electron/updateFeed.cjs`
 * by `vite.config.electron.ts` exactly as `src/lib/db/electronMain.ts` is
 * bundled into `electron/db.cjs`, and for the same reason: `parseRelease()` is
 * the read contract for a release event, and a hand-written copy of it in
 * `electron/` would be a second contract free to drift from the one the
 * download page and the tests exercise. Keep it free of Electron imports — the
 * electron-updater half lives in `electron/nostrUpdateProvider.js`, so `tsc`,
 * eslint and vitest cover everything here as normal source.
 */

import { verifyEvent } from "nostr-tools/pure";

import {
  RELEASE_AUTHORS,
  RELEASE_KIND,
  RELEASE_RELAYS,
  RELEASE_REPO_ID,
  foldReleases,
  parseRelease,
  type Release,
  type ReleaseArtifact,
} from "./releases";

/** How long a single relay gets to answer before it is written off. */
const RELAY_TIMEOUT_MS = 12_000;

/**
 * How many releases to ask each relay for.
 *
 * Only the newest matters, but a relay returning its newest N by `created_at`
 * can hand back a run of prereleases, and a stable build has to find a stable
 * release somewhere in that run. Fifty tags is more history than the channel
 * has ever needed and still a single small response.
 */
const RELEASE_QUERY_LIMIT = 50;

/**
 * Which installer each platform self-updates from.
 *
 * These are exactly the editions `supportsSelfUpdate()` in
 * `electron/updateSupport.js` arms, and the pairing is not incidental: the
 * portable .exe, the .deb and the .flatpak are all present in the same release
 * event, and handing one to electron-updater would have it replace files that
 * belong to a package manager or to a directory the user unpacked by hand.
 * The exclusion of `-portable.exe` is the load-bearing half — CI publishes the
 * NSIS installer and the portable build under the same `windows-x86_64`
 * platform token and the same mime type, so the filename is the only thing that
 * distinguishes them.
 */
const DESKTOP_FORMATS: Record<string, { os: string; accepts: (filename: string) => boolean }> = {
  linux: { os: "linux", accepts: (name) => /\.appimage$/i.test(name) },
  win32: {
    os: "windows",
    accepts: (name) => /\.exe$/i.test(name) && !/-portable\.exe$/i.test(name),
  },
  darwin: { os: "macos", accepts: (name) => /\.zip$/i.test(name) },
};

/**
 * Architecture spellings that mean the same machine.
 *
 * The `f` token is advisory per docs/releases.md, so this is only ever used to
 * REJECT an artifact that names an architecture we are not — never to require
 * that one be named. An `f` of `linux` (or none at all) still matches, because
 * the vocabulary is thin enough that a publisher legitimately omits the arch;
 * an `f` of `linux-aarch64` on an x64 machine is a positive statement that the
 * bytes are for a different CPU, and that one is worth refusing.
 */
const ARCH_ALIASES: Record<string, readonly string[]> = {
  x64: ["x86_64", "x64", "amd64"],
  arm64: ["aarch64", "arm64"],
  arm: ["armv7l", "armhf", "arm"],
  ia32: ["i686", "i386", "x86", "ia32"],
};

/** The machine an update is being resolved for. `process.platform`/`process.arch`. */
export interface DesktopTarget {
  platform: string;
  arch: string;
}

/** One resolved update, in the shape `electron/nostrUpdateProvider.js` needs. */
export interface DesktopUpdate {
  /** Semver with no leading `v`, which is what electron-updater compares. */
  version: string;
  /** The tag as published, e.g. `v0.56.3`. */
  tag: string;
  releaseName: string;
  releaseNotes: string;
  /** ISO 8601, from the event's `created_at`. */
  releaseDate: string;
  /** `main` for stable, `rc` for a prerelease. */
  channel: string;
  file: {
    /** Absolute URL to fetch. See {@link downloadUrl} for the extension. */
    url: string;
    /** The name the installer is cached and installed under. */
    filename: string;
    /** hex — the Blossom content address, and what the download is verified against. */
    sha256: string;
    size: number;
  };
}

export interface ResolveDesktopUpdateOptions {
  target: DesktopTarget;
  /** Whether a release candidate is an acceptable update. */
  allowPrerelease?: boolean;
  relays?: readonly string[];
  authors?: readonly string[];
  repoId?: string;
  /** Injectable for tests; defaults to the runtime's global. */
  webSocket?: typeof WebSocket;
  signal?: AbortSignal;
}

/**
 * The URL to actually download from, which drops a Blossom URL's extension.
 *
 * A published artifact URL is `<server>/<sha256><ext>`, and the extension is the
 * optional half — BUD-01 names the blob `/<sha256>` and every server serves it
 * there. Dropping it is what gets the installer its real filename, which is a
 * property of electron-updater rather than of Blossom: `executeDownload()`
 * names the cached file after the URL's basename when the URL ends in the
 * expected extension, and only otherwise after `UpdateFileInfo.url`, where we
 * put `Armada-v0.56.3.AppImage`. Left with the extension on, every download
 * would be cached — and, on Linux, INSTALLED, since `AppImageUpdater` moves the
 * downloaded file next to the running one under its own name — as
 * `3f9ac2….AppImage`. The user's AppImage would be renamed to a hash.
 *
 * Anything that isn't a bare `/<64 hex>.<ext>` path is returned untouched, so a
 * release published to something other than Blossom still resolves.
 */
export function downloadUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const match = /^\/([0-9a-f]{64})\.[A-Za-z0-9]+$/.exec(parsed.pathname);
    if (!match) return url;
    parsed.pathname = `/${match[1]}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Whether an artifact's `f` token rules it out for this architecture. */
function archMatches(platform: string, arch: string): boolean {
  const dash = platform.indexOf("-");
  if (dash < 0) return true;
  const named = platform.slice(dash + 1).toLowerCase();
  if (!named) return true;
  const accepted = ARCH_ALIASES[arch];
  // An architecture this build has never heard of is not evidence either way;
  // the format check below still has to pass, and that is the stronger signal.
  return accepted == null ? true : accepted.includes(named);
}

/**
 * The one artifact of a release this machine self-updates from, if any.
 *
 * Undefined is a normal answer, not an error: a release built before a platform
 * existed, or one whose Windows job failed, genuinely has nothing here.
 *
 * An artifact with no `x` is not a candidate. `parseRelease` tolerates a missing
 * one — for `/downloads` it costs a checksum nobody was going to type — but here
 * it is the ONLY thing the downloaded bytes are checked against, and an
 * unverifiable installer must not be offered. Skipping rather than throwing
 * keeps the caller's fallback to an older release working.
 */
export function pickDesktopArtifact(
  release: Release,
  target: DesktopTarget,
): ReleaseArtifact | undefined {
  const format = DESKTOP_FORMATS[target.platform];
  if (!format) return undefined;
  return release.artifacts.find(
    (artifact) =>
      artifact.os === format.os &&
      format.accepts(artifact.filename) &&
      archMatches(artifact.platform, target.arch) &&
      /^[0-9a-f]{64}$/.test(artifact.hash),
  );
}

/** Strip the tag's leading `v`, since electron-updater compares with semver. */
function semver(version: string): string {
  return version.replace(/^v/i, "");
}

/** Pair a parsed release with its artifact, in the updater's shape. */
export function toDesktopUpdate(
  release: Release,
  artifact: ReleaseArtifact,
): DesktopUpdate {
  return {
    version: semver(release.version),
    tag: release.version,
    releaseName: release.title,
    releaseNotes: release.notes,
    releaseDate: new Date(release.createdAt * 1000).toISOString(),
    channel: release.channel,
    file: {
      url: downloadUrl(artifact.url),
      filename: artifact.filename,
      sha256: artifact.hash,
      size: artifact.size,
    },
  };
}

/**
 * Turn relay responses into the release to offer.
 *
 * Every check here is a refusal a malicious relay would otherwise get past,
 * and none of them can be skipped on the grounds that some other layer does it:
 * the events arrive over a plain WebSocket from a server that is not trusted
 * for anything, and the artifact URL they carry is a binary this process is
 * about to download and hand to an installer.
 *
 * - the signature must verify, or a relay can mint an event under any pubkey;
 * - the author must be one of the BUILD-PINNED release keys, or any valid
 *   signature will do;
 * - the `D` tag must be this repository, or a release of some other project
 *   signed by the same maintainer would install over Armada.
 */
export function selectDesktopRelease(
  events: readonly unknown[],
  {
    target,
    allowPrerelease = false,
    authors = RELEASE_AUTHORS,
    repoId = RELEASE_REPO_ID,
  }: {
    target: DesktopTarget;
    allowPrerelease?: boolean;
    authors?: readonly string[];
    repoId?: string;
  },
): DesktopUpdate | undefined {
  const trusted = new Set(authors.map((author) => author.toLowerCase()));
  const releases: Release[] = [];
  for (const event of events) {
    if (!isReleaseEvent(event)) continue;
    if (!trusted.has(event.pubkey.toLowerCase())) continue;
    if (!verifyEvent(event)) continue;
    const release = parseRelease(event);
    if (!release || release.repoId !== repoId) continue;
    releases.push(release);
  }

  const folded = foldReleases(releases);
  // Newest-first, so an rc build takes the head and a stable build takes the
  // newest release on the stable channel — the same rule `/downloads` features
  // by, and the same one electron-updater applies to its own `allowPrerelease`.
  const candidates = allowPrerelease ? folded : folded.filter((r) => r.channel === "main");
  for (const release of candidates) {
    const artifact = pickDesktopArtifact(release, target);
    // Don't stop at the newest release: a version whose Windows build failed
    // still publishes an event, and offering nothing because the HEAD release
    // lacks this platform would strand it until the next tag.
    if (artifact) return toDesktopUpdate(release, artifact);
  }
  return undefined;
}

/** The bits of a signed Nostr event this module needs, checked at the boundary. */
interface SignedEvent {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
  sig: string;
}

function isReleaseEvent(value: unknown): value is SignedEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    event.kind === RELEASE_KIND &&
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.sig === "string" &&
    typeof event.content === "string" &&
    typeof event.created_at === "number" &&
    Array.isArray(event.tags)
  );
}

/**
 * Read one relay's copy of the release history.
 *
 * Never rejects. A relay that is down, slow, wrong or hostile contributes
 * nothing and the others still answer; an update check that threw because one
 * of three relays refused a connection would report "update check failed" to a
 * user whose update was sitting on the other two.
 */
function queryRelay(
  url: string,
  filter: unknown,
  WebSocketImpl: typeof WebSocket,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const events: unknown[] = [];
    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(url);
    } catch {
      resolve([]);
      return;
    }

    const subscriptionId = `armada-update-${Math.random().toString(36).slice(2, 10)}`;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      try {
        socket.close();
      } catch {
        // Already closing, or never opened. The result is the same either way.
      }
      resolve(events);
    };

    const timer = setTimeout(finish, RELAY_TIMEOUT_MS);
    // A pending update check must never be the reason the app won't quit.
    (timer as unknown as { unref?: () => void }).unref?.();
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish);

    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify(["REQ", subscriptionId, filter]));
      } catch {
        finish();
      }
    });
    socket.addEventListener("message", (message: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof message.data === "string" ? message.data : "");
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed[1] !== subscriptionId) return;
      if (parsed[0] === "EVENT") events.push(parsed[2]);
      // CLOSED as well as EOSE: a relay that refuses the subscription (AUTH,
      // rate limit) answers once and never sends EOSE, and waiting out the
      // timeout for it would delay the whole check by that much.
      else if (parsed[0] === "EOSE" || parsed[0] === "CLOSED") finish();
    });
    socket.addEventListener("error", finish);
    socket.addEventListener("close", finish);
  });
}

/**
 * The update this machine should install, or undefined if it is current.
 *
 * "Current" is not decided here — electron-updater compares the returned
 * version against the running one and applies its own downgrade and staging
 * rules. This returns the newest INSTALLABLE release it can find, and
 * undefined only when the relays produced no release with an artifact for this
 * platform at all.
 */
export async function resolveDesktopUpdate({
  target,
  allowPrerelease = false,
  relays = RELEASE_RELAYS,
  authors = RELEASE_AUTHORS,
  repoId = RELEASE_REPO_ID,
  webSocket,
  signal,
}: ResolveDesktopUpdateOptions): Promise<DesktopUpdate | undefined> {
  const WebSocketImpl =
    webSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketImpl) {
    throw new Error("no WebSocket implementation available for the update check");
  }
  if (relays.length === 0) throw new Error("no release relays configured");
  if (authors.length === 0) throw new Error("no release authors configured");

  const filter = {
    kinds: [RELEASE_KIND],
    authors: [...authors],
    "#D": [repoId],
    limit: RELEASE_QUERY_LIMIT,
  };
  const responses = await Promise.all(
    relays.map((relay) => queryRelay(relay, filter, WebSocketImpl, signal)),
  );

  return selectDesktopRelease(responses.flat(), {
    target,
    allowPrerelease,
    authors,
    repoId,
  });
}

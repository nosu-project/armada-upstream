/**
 * The desktop shell's update feed: the kind-30622 release event (the same one
 * `/downloads` reads), narrowed to the installer this machine can install —
 * content-addressed and signed by a pinned maintainer key. Also resolves the
 * Flatpak's web bundle from the signed nsite manifest ({@link resolveWebBundle}).
 *
 * Bundled into `electron/updateFeed.cjs` (like `electronMain.ts`) so
 * `parseRelease()` stays the single read contract. Keep it free of Electron
 * imports; the electron-updater half is `electron/nostrUpdateProvider.js`.
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

// Re-exported so the bundled `electron/updateFeed.cjs` shares the version comparison.
export { compareVersions } from "./releases";

const RELAY_TIMEOUT_MS = 12_000;

/**
 * Releases asked of each relay: a relay's newest N can be a run of
 * prereleases, and a stable build must still find a stable one in it.
 */
const RELEASE_QUERY_LIMIT = 50;

/**
 * Which installer each platform self-updates from; matches
 * `supportsSelfUpdate()` in `electron/updateSupport.js`. Package-manager and
 * portable builds must never go to electron-updater; `-portable.exe` shares the
 * NSIS installer's platform token and mime, so the filename is the only tell.
 *
 * `flatpak` is a SYNTHETIC target (passed when `FLATPAK_ID` is set), kept out
 * of `linux` so electron-updater never gets it: `/app` is read-only and the
 * shell updates its web bundle instead (`electron/webBundleUpdate.js`).
 */
const DESKTOP_FORMATS: Record<string, { os: string; accepts: (filename: string) => boolean }> = {
  linux: { os: "linux", accepts: (name) => /\.appimage$/i.test(name) },
  win32: {
    os: "windows",
    accepts: (name) => /\.exe$/i.test(name) && !/-portable\.exe$/i.test(name),
  },
  darwin: { os: "macos", accepts: (name) => /\.zip$/i.test(name) },
  flatpak: { os: "linux", accepts: (name) => /\.flatpak$/i.test(name) },
};

/**
 * Architecture spellings for the same machine. The `f` token is advisory
 * (docs/releases.md): only used to REJECT an artifact naming another arch,
 * never to require one.
 */
const ARCH_ALIASES: Record<string, readonly string[]> = {
  x64: ["x86_64", "x64", "amd64"],
  arm64: ["aarch64", "arm64"],
  arm: ["armv7l", "armhf", "arm"],
  ia32: ["i686", "i386", "x86", "ia32"],
};

export interface DesktopTarget {
  platform: string;
  arch: string;
}

export interface DesktopUpdate {
  /** Semver with no leading `v`, which is what electron-updater compares. */
  version: string;
  tag: string;
  releaseName: string;
  releaseNotes: string;
  /** ISO 8601, from the event's `created_at`. */
  releaseDate: string;
  channel: string;
  file: {
    /** Absolute URL to fetch (see {@link downloadUrl}). */
    url: string;
    filename: string;
    /** Hex Blossom content address; the download is verified against it. */
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
 * The download URL with a Blossom URL's extension dropped (BUD-01 serves
 * `/<sha256>`). Otherwise electron-updater names the cached — and on Linux,
 * INSTALLED — AppImage after the hash. Non-Blossom URLs pass through.
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
  // Unknown arch isn't evidence either way; the format check still applies.
  return accepted == null ? true : accepted.includes(named);
}

/**
 * The artifact this machine self-updates from, if any (undefined is normal).
 * Artifacts without a hash are skipped: here it's the ONLY verification, so an
 * unverifiable installer is never offered.
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

function semver(version: string): string {
  return version.replace(/^v/i, "");
}

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
 * Turn untrusted relay responses into the release to offer (the artifact is a
 * binary about to be installed). Each check blocks a malicious relay: the
 * signature must verify, the author must be a BUILD-PINNED release key, and
 * the `D` tag must be this repo (not another project by the same maintainer).
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
  // Newest-first; stable builds take the newest `main` release (as `/downloads` does).
  const candidates = allowPrerelease ? folded : folded.filter((r) => r.channel === "main");
  for (const release of candidates) {
    const artifact = pickDesktopArtifact(release, target);
    // Skip releases lacking this platform (e.g. a failed Windows build).
    if (artifact) return toDesktopUpdate(release, artifact);
  }
  return undefined;
}

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
  return isSignedEvent(value) && value.kind === RELEASE_KIND;
}

function isSignedEvent(value: unknown): value is SignedEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.kind === "number" &&
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.sig === "string" &&
    typeof event.content === "string" &&
    typeof event.created_at === "number" &&
    Array.isArray(event.tags)
  );
}

/**
 * Read one relay's release history. Never rejects: a bad relay contributes
 * nothing so the others can still answer.
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
      } catch { /* ignore */ }
      resolve(events);
    };

    const timer = setTimeout(finish, RELAY_TIMEOUT_MS);
    // Never keep the app from quitting.
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
      // CLOSED too: a refusing relay (AUTH, rate limit) never sends EOSE.
      else if (parsed[0] === "EOSE" || parsed[0] === "CLOSED") finish();
    });
    socket.addEventListener("error", finish);
    socket.addEventListener("close", finish);
  });
}

/** NIP-5A named site manifest. */
const NSITE_KIND = 35128;

/** The named site `.nsite/config.json` publishes. */
export const WEB_BUNDLE_SITE_ID = "armada";

/** Where every web deploy puts its `dist` archive (deploy-nsite.yml). */
export const WEB_BUNDLE_PATH = "/downloads/armada-web.tar.gz";

export interface WebBundleUpdate {
  /**
   * Manifest `created_at`; the shell refuses an older one (relays may serve
   * stale replaceable events).
   */
  createdAt: number;
  sha256: string;
  /** `<server>/<sha256>` for each https Blossom server in the manifest, in order. */
  urls: string[];
}

/**
 * The web bundle from the newest acceptable signed site manifest. Same
 * refusals as {@link selectDesktopRelease} (verified signature, BUILD-PINNED
 * author); `path`/`server` tags are read only from the verified event.
 */
export function selectWebBundle(
  events: readonly unknown[],
  {
    authors = RELEASE_AUTHORS,
    siteId = WEB_BUNDLE_SITE_ID,
  }: { authors?: readonly string[]; siteId?: string } = {},
): WebBundleUpdate | undefined {
  const trusted = new Set(authors.map((author) => author.toLowerCase()));
  let newest: SignedEvent | undefined;
  for (const event of events) {
    if (!isSignedEvent(event) || event.kind !== NSITE_KIND) continue;
    if (!trusted.has(event.pubkey.toLowerCase())) continue;
    if (!event.tags.some((tag) => tag[0] === "d" && tag[1] === siteId)) continue;
    if (newest && event.created_at <= newest.created_at) continue;
    if (!verifyEvent(event)) continue;
    newest = event;
  }
  if (!newest) return undefined;

  const hash = newest.tags.find((tag) => tag[0] === "path" && tag[1] === WEB_BUNDLE_PATH)?.[2];
  const sha256 = typeof hash === "string" ? hash.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  const urls: string[] = [];
  for (const tag of newest.tags) {
    if (tag[0] !== "server" || typeof tag[1] !== "string") continue;
    try {
      const server = new URL(tag[1]);
      if (server.protocol !== "https:") continue;
      const url = new URL(`/${sha256}`, server).href;
      if (!urls.includes(url)) urls.push(url);
    } catch { /* ignore */ }
  }
  if (urls.length === 0) return undefined;
  return { createdAt: newest.created_at, sha256, urls };
}

/** The deployed web bundle from the site manifest on the release relays; undefined if none acceptable. */
export async function resolveWebBundle({
  relays = RELEASE_RELAYS,
  authors = RELEASE_AUTHORS,
  siteId = WEB_BUNDLE_SITE_ID,
  webSocket,
  signal,
}: {
  relays?: readonly string[];
  authors?: readonly string[];
  siteId?: string;
  webSocket?: typeof WebSocket;
  signal?: AbortSignal;
} = {}): Promise<WebBundleUpdate | undefined> {
  const WebSocketImpl =
    webSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketImpl) {
    throw new Error("no WebSocket implementation available for the bundle check");
  }
  if (relays.length === 0) throw new Error("no site relays configured");
  if (authors.length === 0) throw new Error("no release authors configured");

  const filter = { kinds: [NSITE_KIND], authors: [...authors], "#d": [siteId] };
  const responses = await Promise.all(
    relays.map((relay) => queryRelay(relay, filter, WebSocketImpl, signal)),
  );
  return selectWebBundle(responses.flat(), { authors, siteId });
}

/**
 * The newest installable release for this machine, or undefined if none has an
 * artifact for it. Whether it is newer than the running build is
 * electron-updater's call. Called only from `electron/nostrUpdateProvider.js`.
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

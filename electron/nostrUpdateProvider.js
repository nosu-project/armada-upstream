"use strict";

/**
 * electron-updater's view of the Nostr release event.
 *
 * The desktop app self-updates from the SAME kind-30622 event `/downloads`
 * renders, rather than from `latest*.yml` on a web server. electron-updater
 * supports this through its `custom` publish provider: `setFeedURL()` is handed
 * a class, `providerFactory.createClient()` instantiates it, and the updater
 * then drives it exactly as it drives the GitHub or generic providers. Nothing
 * below reimplements downloading, staging, elevation or installation — the
 * platform updaters (`NsisUpdater`, `AppImageUpdater`, `MacUpdater`) keep doing
 * all of that. This only answers two questions: what is the latest version, and
 * where are its bytes.
 *
 * Everything about the event itself — relays, signature and author checks,
 * choosing the artifact for this platform — is in `updateFeed.cjs`, the bundled
 * build of `src/lib/desktopUpdate.ts`. So this file has no protocol knowledge
 * and that file has no Electron knowledge.
 */

const { Provider } = require("electron-updater");

/**
 * Map a resolved release onto electron-updater's `UpdateInfo`.
 *
 * Split out from the class because it holds the one decision in this file, and
 * because the class cannot be constructed without an updater to attach to.
 */
function updateInfoFrom(update) {
  // The release event's `x`, which is also the artifact's Blossom content
  // address — so the hash the download is checked against is the same fact the
  // URL already commits to, rather than a second one to keep in step.
  //
  // `sha2` rather than `sha512` because sha256 is what we have and what the
  // event publishes. electron-updater runs a `sha2` value through
  // `DigestTransform(…, "sha256", "hex")`, so the download is fully verified.
  // sha256 is not the weaker choice here: it is the same SHA-2 family, its
  // 128-bit collision resistance is far beyond what a content address needs,
  // and on any CPU with SHA-NI or ARMv8 crypto extensions it is the FASTER of
  // the two. The library's sha512 default is a 2016-era software-speed call,
  // and `sha2` is only marked deprecated because it once cross-checked a
  // Bintray response header. Don't "modernize" this by publishing a sha512.
  //
  // The one thing given up: `DownloadedUpdateHelper` revalidates an
  // already-downloaded file by recomputing sha512, so a pending download is
  // re-fetched after a restart instead of resumed. That costs background
  // bandwidth in one narrow case (downloaded, then killed before the
  // install-on-quit ran) and nothing else.
  if (!update.file.sha256) {
    throw new Error(`release artifact ${update.file.filename} carries no checksum`);
  }
  const file = { url: update.file.filename, size: update.file.size, sha2: update.file.sha256 };

  return {
    version: update.version,
    files: [file],
    // Deprecated on UpdateInfo, and read only when `files` is empty. Kept
    // consistent rather than omitted so anything reaching for it agrees with
    // `files[0]`.
    path: file.url,
    releaseName: update.releaseName,
    releaseNotes: update.releaseNotes,
    releaseDate: update.releaseDate,
  };
}

class NostrReleaseProvider extends Provider {
  constructor(options, updater, runtimeOptions) {
    super(runtimeOptions);
    this.options = options;
    this.updater = updater;
    // The absolute download URL, keyed by version. `resolveFiles()` is handed
    // only an `UpdateInfo`, which has nowhere to put an absolute URL: the
    // built-in providers rebuild one by resolving a relative path against a
    // feed base URL, and a content-addressed artifact has no such base. The
    // provider instance outlives the check (electron-updater caches the client
    // it built from `setFeedURL`), so the pairing survives between the two
    // calls.
    this.downloads = new Map();
  }

  async getLatestVersion() {
    // Required lazily. The bundle is a gitignored build artifact, and this
    // module is imported by tests that run before anything is built; requiring
    // it at load would also make a missing bundle an app that cannot start, at
    // the cost of a feature that is only auto-update. `before-pack.cjs` and the
    // `files:` list in electron-builder.yml are what guarantee it ships.
    const { resolveDesktopUpdate } = require("./updateFeed.cjs");

    const update = await resolveDesktopUpdate({
      target: { platform: process.platform, arch: process.arch },
      // The updater sets this itself from the RUNNING version: a build that is
      // already a prerelease accepts prereleases, a stable build does not.
      allowPrerelease: this.updater?.allowPrerelease === true,
    });

    if (update == null) {
      throw new Error(
        `no ${process.platform}/${process.arch} release artifact was found in the release event`,
      );
    }

    this.downloads.set(update.version, update.file.url);
    return updateInfoFrom(update);
  }

  resolveFiles(updateInfo) {
    const url = this.downloads.get(updateInfo.version);
    if (url == null) {
      throw new Error(`no download URL was resolved for version ${updateInfo.version}`);
    }
    // `info.url` is the artifact's FILENAME, not a URL, and that is deliberate:
    // `AppUpdater.executeDownload()` names the cached file after the download
    // URL's basename only when that URL ends in the expected extension, and
    // otherwise after this field. A Blossom URL's basename is a hash, and on
    // Linux the cache name becomes the INSTALLED name, so the pair of this and
    // the extension-less URL from `downloadUrl()` is what keeps the user's
    // AppImage called Armada-v0.56.3.AppImage instead of 3f9ac2….AppImage.
    return [{ url: new URL(url), info: updateInfo.files[0] }];
  }
}

module.exports = { NostrReleaseProvider, updateInfoFrom };

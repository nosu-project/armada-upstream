/**
 * The install targets `/downloads` offers, where their files live, and how to
 * guess which one the visitor wants.
 *
 * The URLs here are STABLE, unversioned aliases (`Armada.AppImage`,
 * `Armada.apk`, …) that `.ngit/act/workflows/desktop.yml` and `release.yml`
 * republish on every version tag beside the versioned archive. That is what
 * lets this table be a compile-time constant: the page never has to discover a
 * version before it can render a working button.
 *
 * The manifests are the other half of that split, and are deliberately only
 * decoration — a version label and a file size. Each CI workflow writes its own
 * (`latest-desktop.json`, `latest-android.json`) because both fire on the same
 * tag and run concurrently, so a single shared file would be a lost update. If
 * a fetch fails, or a manifest is stale because one platform's build broke, the
 * page loses a label and keeps every download.
 */

import { PUBLIC_WEB_ORIGIN } from "./shareOrigin";

/**
 * Where the installers are served from.
 *
 * Absolute, and pointing at the public deployment rather than
 * `window.location.origin`, because the binaries only exist where CI publishes
 * them. A self-hosted build serving its own origin has no `/downloads`
 * directory, so a relative link there would hit the SPA fallback and hand the
 * user an HTML page named `Armada.deb`. Operators who do build their own
 * installers can point this at them with `VITE_DOWNLOADS_BASE_URL`.
 */
export const DOWNLOADS_BASE_URL: string = (
  import.meta.env.VITE_DOWNLOADS_BASE_URL || `${PUBLIC_WEB_ORIGIN}/downloads`
).replace(/\/+$/, "");

/** Operating systems the page can recognize and offer something for. */
export type DownloadOs = "linux" | "windows" | "macos" | "android" | "ios";

/** Which CI workflow's manifest describes a target's files. */
export type ManifestName = "desktop" | "android";

export interface DownloadAsset {
  /** Matches the key under `files` in the manifest. */
  id: string;
  label: string;
  /** One line telling the user which of a target's assets is theirs. */
  hint: string;
  /** Stable filename under {@link DOWNLOADS_BASE_URL}. */
  file: string;
  /**
   * The shell command to install or run this build, for the ones that are
   * driven from a terminal rather than double-clicked (an AppImage has to be
   * marked executable, a .deb and a Flatpak bundle install from the CLI). The
   * page shows it beneath the download button. Written against the stable
   * filename, since that is what the user has after the download.
   */
  command?: string;
}

export interface DownloadTarget {
  os: DownloadOs;
  name: string;
  /** Empty when the platform has no installable build (see iOS). */
  assets: DownloadAsset[];
  manifest?: ManifestName;
}

export interface ManifestFile {
  file: string;
  size: number;
}

export interface DownloadsManifest {
  tag: string;
  version: string;
  published?: string;
  files?: Record<string, ManifestFile>;
}

export const DOWNLOAD_TARGETS: DownloadTarget[] = [
  {
    os: "linux",
    name: "Linux",
    manifest: "desktop",
    assets: [
      { id: "linux-appimage", label: "AppImage", hint: "Any distribution. Mark it executable and run it", file: "Armada.AppImage", command: "chmod +x Armada.AppImage && ./Armada.AppImage" },
      { id: "linux-deb", label: "Debian package", hint: "Debian, Ubuntu and derivatives", file: "Armada.deb", command: "sudo apt install ./Armada.deb" },
      { id: "linux-flatpak", label: "Flatpak", hint: "Sandboxed, any distribution with Flatpak", file: "Armada.flatpak", command: "flatpak install Armada.flatpak" },
    ],
  },
  {
    os: "windows",
    name: "Windows",
    manifest: "desktop",
    assets: [
      { id: "windows-setup", label: "Installer", hint: "Installs Armada and adds a Start menu entry", file: "Armada-Setup.exe" },
      { id: "windows-portable", label: "Portable", hint: "A single .exe that installs nothing", file: "Armada-portable.exe" },
    ],
  },
  {
    os: "macos",
    name: "macOS",
    manifest: "desktop",
    assets: [
      { id: "macos-arm64", label: "Apple Silicon", hint: "M1 and newer", file: "Armada-mac-arm64.zip" },
      { id: "macos-x64", label: "Intel", hint: "Macs from before 2020", file: "Armada-mac-x64.zip" },
    ],
  },
  {
    os: "android",
    name: "Android",
    manifest: "android",
    assets: [
      { id: "android-apk", label: "APK", hint: "Install directly, no store account needed", file: "Armada.apk" },
    ],
  },
  // No iOS build is published: there is no iOS CI, and TestFlight/App Store
  // distribution isn't set up. The page offers the web app instead of a button
  // that can't exist, which is why this target carries no assets.
  { os: "ios", name: "iPhone & iPad", assets: [] },
];

/** An external app store listing, as opposed to a file CI publishes. */
export interface AppStore {
  label: string;
  /** One line saying what the store is, where there's room for it. */
  hint: string;
  url: string;
  /**
   * The store's own mark, as a path under `public/`. A file rather than an
   * inline component because one of the two is only distributed as a raster
   * logo, and a table where one row is a path and the other a React node
   * couldn't be rendered by one loop.
   */
  icon: string;
}

/**
 * Where an Android user can get the app without sideloading.
 *
 * These sit BESIDE {@link DOWNLOAD_TARGETS} rather than in it because
 * `downloads.test.ts` asserts that every asset in that table is a filename one
 * of the CI workflows publishes, and a store listing is neither a file nor
 * ours. Both the landing page and `/downloads` render this list, so the URLs
 * and the marks are written down once.
 */
export const ANDROID_STORES: AppStore[] = [
  {
    label: "Google Play",
    hint: "Install from the Play Store",
    url: "https://play.google.com/store/apps/details?id=buzz.armada.app&hl=en-US",
    icon: "/stores/google-play.svg",
  },
  {
    label: "Zapstore",
    hint: "The Nostr-native app store",
    url: "https://zapstore.dev/apps/buzz.armada.app",
    icon: "/stores/zapstore.png",
  },
];

/** The absolute URL a download button points at. */
export function downloadUrl(file: string): string {
  return `${DOWNLOADS_BASE_URL}/${file}`;
}

/** The absolute URL of a platform family's manifest. */
export function manifestUrl(name: ManifestName): string {
  return `${DOWNLOADS_BASE_URL}/latest-${name}.json`;
}

/**
 * Guess the visitor's OS from a user-agent string.
 *
 * Order is load-bearing twice over: Android's UA contains "Linux", and iOS's
 * contains "like Mac OS X", so the more specific test has to run first or every
 * phone reads as a desktop. `touchPoints` catches iPadOS, which since 13 asks
 * for desktop sites by default and so presents a plain "Macintosh" UA — a Mac
 * with a touchscreen is the tell.
 *
 * Returns undefined rather than a default when nothing matches: the page falls
 * back to showing every platform equally, which is strictly better than
 * confidently featuring the wrong one.
 */
export function detectOs(ua: string, touchPoints = 0): DownloadOs | undefined {
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/macintosh|mac os x/i.test(ua)) return touchPoints > 1 ? "ios" : "macos";
  if (/windows|win32|win64/i.test(ua)) return "windows";
  // CrOS ahead of the generic Linux match only for clarity; either lands on
  // Linux, where Crostini makes the .deb the working answer.
  if (/cros|linux|x11/i.test(ua)) return "linux";
  return undefined;
}

/** {@link detectOs} against the live browser. */
export function detectCurrentOs(): DownloadOs | undefined {
  if (typeof navigator === "undefined") return undefined;
  return detectOs(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

/** Human-readable file size for a manifest entry. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

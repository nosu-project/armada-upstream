/**
 * The platform side of `/downloads`: install targets, OS detection, install
 * commands and store listings. Release contents (files, hashes, URLs) come
 * from the kind-30622 event (`src/lib/releases.ts`).
 */

export type DownloadOs = "linux" | "windows" | "macos" | "android" | "ios";

export interface DownloadPlatform {
  os: DownloadOs;
  name: string;
  /** Shown when a release carries nothing for this platform. */
  empty?: string;
}

/** Every platform card, in fallback order. iOS has no build here (App Store isn't in this pipeline). */
export const DOWNLOAD_PLATFORMS: DownloadPlatform[] = [
  { os: "linux", name: "Linux" },
  { os: "windows", name: "Windows" },
  { os: "macos", name: "macOS" },
  { os: "android", name: "Android" },
  { os: "ios", name: "iPhone & iPad", empty: "official app coming soon" },
];

/**
 * Shell command to run a downloaded file, keyed by extension (filenames carry
 * versions). Only AppImage: `.deb`/`.flatpak` go through {@link PACKAGE_MANAGERS}.
 */
export function installCommand(filename: string): string | undefined {
  if (/\.AppImage$/i.test(filename)) return `chmod +x ${filename} && ./${filename}`;
  return undefined;
}

/** Formats pkg.soapbox.pub republishes as package repos, so `/downloads` shows repo commands instead of the file. */
export function isRepublishedPackage(filename: string): boolean {
  return /\.(deb|flatpak)$/i.test(filename);
}

/**
 * The npkg (https://github.com/soapbox-pub/npkg) instance: verifies release
 * artifacts against the event's hashes and re-signs package repos with its own keys.
 */
export const NPKG_HOST = "pkg.soapbox.pub";

/** A pkg.soapbox.pub repository and its copyable setup/install commands. */
export interface PackageManager {
  os: DownloadOs;
  label: string;
  setup: string[];
  /** Installs Armada; `flatpak/apt update` upgrades it thereafter. */
  install: string;
}

export const PACKAGE_MANAGERS: PackageManager[] = [
  {
    os: "linux",
    label: "Debian / Ubuntu (APT)",
    setup: [
      "sudo install -d -m 0755 /etc/apt/keyrings",
      `curl -fsSL https://${NPKG_HOST}/apt/key.asc | sudo tee /etc/apt/keyrings/soapbox.asc > /dev/null`,
      `echo "deb [signed-by=/etc/apt/keyrings/soapbox.asc] https://${NPKG_HOST}/apt stable main" | sudo tee /etc/apt/sources.list.d/soapbox.list`,
      "sudo apt update",
    ],
    install: "sudo apt install armada-desktop",
  },
  {
    os: "linux",
    label: "Flatpak",
    setup: [
      `flatpak remote-add --if-not-exists soapbox https://${NPKG_HOST}/flatpak/soapbox.flatpakrepo`,
    ],
    install: "flatpak install soapbox buzz.armada.app",
  },
];

export interface AppStore {
  label: string;
  /** One line describing the store. */
  hint: string;
  url: string;
  /** The store's mark as a path under `public/` (one is raster-only). */
  icon: string;
}

/** Android store listings (not part of a release); shared by the landing page and `/downloads`. */
export const ANDROID_STORES: AppStore[] = [
  {
    label: "Google Play",
    hint: "Install from the Play Store",
    url: "https://play.google.com/store/apps/details?id=buzz.armada.app&hl=en-US",
    icon: "/stores/google-play.svg",
  },
  {
    label: "F-Droid",
    hint: "Add the Soapbox repository",
    // The npkg F-Droid repo; the link hands repo + pinned fingerprint to the F-Droid app.
    url: `https://${NPKG_HOST}/fdroid/main/repo?fingerprint=CEA02E48815EC61244B5ECB35680B745A7A9A41A9257382F1D8BDDC14E533A17`,
    icon: "/stores/fdroid.svg",
  },
  {
    label: "Zapstore",
    hint: "The Nostr-native app store",
    url: "https://zapstore.dev/apps/buzz.armada.app",
    icon: "/stores/zapstore.png",
  },
];

/**
 * Guess the visitor's OS from a user-agent. Order matters: Android UAs contain
 * "Linux" and iOS "like Mac OS X". A touch-capable "Macintosh" is iPadOS 13+.
 * Undefined when unknown (show every platform rather than feature a wrong one).
 */
export function detectOs(ua: string, touchPoints = 0): DownloadOs | undefined {
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/macintosh|mac os x/i.test(ua)) return touchPoints > 1 ? "ios" : "macos";
  if (/windows|win32|win64/i.test(ua)) return "windows";
  // ChromeOS: Crostini makes the .deb the working answer.
  if (/cros|linux|x11/i.test(ua)) return "linux";
  return undefined;
}

export function detectCurrentOs(): DownloadOs | undefined {
  if (typeof navigator === "undefined") return undefined;
  return detectOs(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

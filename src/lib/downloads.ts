/**
 * The platform side of `/downloads`: which install targets exist, how to guess
 * which one the visitor wants, and what to type after the file lands.
 *
 * What a release CONTAINS is not here — it comes off the relays as a kind-30622
 * event (`src/lib/releases.ts`, `docs/releases.md`), so filenames, sizes,
 * hashes and download URLs are all discovered rather than compiled in. This
 * module holds only what a release event has no business carrying: display
 * names, the shell incantation a given file type needs, and the store listings
 * that aren't files at all.
 */

/** Operating systems the page can recognize and offer something for. */
export type DownloadOs = "linux" | "windows" | "macos" | "android" | "ios";

export interface DownloadPlatform {
  os: DownloadOs;
  name: string;
  /** Shown when a release carries nothing for this platform. */
  empty?: string;
}

/**
 * Every platform the page shows a card for, in fallback order.
 *
 * iOS is listed with no build of its own on purpose: the App Store release is
 * not published through this pipeline, so the card offers the web app rather
 * than a button that can't exist.
 */
export const DOWNLOAD_PLATFORMS: DownloadPlatform[] = [
  { os: "linux", name: "Linux" },
  { os: "windows", name: "Windows" },
  { os: "macos", name: "macOS" },
  { os: "android", name: "Android" },
  { os: "ios", name: "iPhone & iPad", empty: "official app coming soon" },
];

/**
 * The shell command to install or run a downloaded file.
 *
 * Keyed off the extension rather than a table of known filenames, because the
 * names now come from the release event and carry its version — there is no
 * fixed `Armada.AppImage` to write a command against any more.
 *
 * Only the AppImage has one: the `.deb` and `.flatpak` are served through the
 * pkg.soapbox.pub package repositories (see {@link PACKAGE_MANAGERS}), so the
 * page points at the repo rather than offering the raw file to sideload.
 */
export function installCommand(filename: string): string | undefined {
  if (/\.AppImage$/i.test(filename)) return `chmod +x ${filename} && ./${filename}`;
  return undefined;
}

/**
 * A build format that pkg.soapbox.pub republishes as a real package repository,
 * so `/downloads` hides the raw file and shows the repo's install commands
 * instead. The artifact stays in the release event — it is npkg's input — but
 * a user installs it through their package manager, not by downloading it here.
 */
export function isRepublishedPackage(filename: string): boolean {
  return /\.(deb|flatpak)$/i.test(filename);
}

/**
 * The npkg (https://github.com/soapbox-pub/npkg) instance that turns Armada's
 * Nostr releases into installable package repositories. It watches the kind-30622
 * release events, verifies each artifact against the hash the event published,
 * and re-signs the repositories with its own keys — so a package manager pointed
 * at it trusts this instance, which in turn trusts the release event's hash.
 */
export const NPKG_HOST = "pkg.soapbox.pub";

/**
 * A package repository pkg.soapbox.pub serves, and the commands that add it and
 * install from it. Rendered as copyable command blocks on the platform card, in
 * place of the raw `.deb`/`.flatpak` download the repository replaces.
 */
export interface PackageManager {
  os: DownloadOs;
  label: string;
  /** Run once, to add the repository. */
  setup: string[];
  /** Installs Armada afterward; `flatpak/apt update` upgrades it thereafter. */
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
 * Not part of a release: a store listing is a stable destination that outlives
 * any one version, and neither store is ours to publish an artifact for. Both
 * the landing page and `/downloads` render this list, so it lives here once.
 */
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
    // The npkg F-Droid repo on pkg.soapbox.pub. Opening the link on-device
    // hands the whole URL — repo plus pinned fingerprint — to the F-Droid app.
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

"use strict";

// Desktop-entry integration for the Linux AppImage.
//
// An AppImage is one file the user runs from wherever they downloaded it, and
// nothing installs a .desktop entry for it. That is invisible until you look
// at the dock. A desktop environment names a running app after the .desktop
// entry its window matches, and it matches by WM_CLASS -> StartupWMClass;
// Electron derives WM_CLASS from `app.setDesktopName()` (main.js), so with no
// entry installed there is nothing to match, and the shell falls back to the
// raw class string — the dock tooltip reads "buzz.armada.app", and the icon
// beside it is whatever the window itself carries rather than the launcher
// art. The deb and the Flatpak both install an entry and so never show this.
//
// So the AppImage installs its own, on launch, into XDG_DATA_HOME: the same
// id, Name and StartupWMClass the packaged entries use, so the window matches,
// the dock says "Armada", and the app becomes searchable/pinnable like any
// installed one. Deliberately narrow about when it writes anything:
//
//   • Only when $APPIMAGE is set. deb and Flatpak ship their own entry, and
//     `npm start` is not something that should write into the user's home.
//   • It never clobbers an entry it did not write itself (a hand-edited one,
//     or AppImageLauncher's), and stands down when a system-wide entry, or
//     another entry pointing at this same AppImage, already exists.
//   • ARMADA_NO_DESKTOP_INTEGRATION=1 opts out entirely.
//
// Nothing here is load-bearing for the app running: every failure is reported
// and swallowed.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DESKTOP_ID = "buzz.armada.app";
const DESKTOP_FILE = `${DESKTOP_ID}.desktop`;

// Written into every entry this module generates, and the ONLY thing that
// authorizes overwriting one. An entry without it belongs to somebody else.
const MARKER_KEY = "X-Armada-Desktop-Entry";
// The AppImage the entry was written for, so moving/renaming the file is
// detected as a rewrite rather than leaving a launcher that fails to start.
const SOURCE_KEY = "X-Armada-AppImage";

// Must match the entry electron-builder generates for the packaged targets
// (electron/electron-builder.yml -> linux.desktop.entry). An AppImage that
// integrates itself and a deb that was installed should be the same app, not
// two spellings of one; desktopIntegration.test.mjs reads the yaml and fails
// if these drift apart.
const ENTRY_FIELDS = {
  Name: "Armada",
  Comment: "Sovereign NIP-29 chat, channels, and voice",
  Categories: "Network;Chat;InstantMessaging;",
};

// hicolor sizes to install. A single 512 would be scaled by the theme, but the
// panel/dock sizes are the ones actually drawn all day, and a downscale done
// once at install time beats one done per lookup at whatever quality the
// consumer picks.
const ICON_SIZES = [512, 256, 128, 64, 48];

/**
 * $XDG_DATA_HOME, or its spec default. A relative value is invalid per the
 * basedir spec and is treated as unset.
 */
function xdgDataHome(env = process.env, homedir = os.homedir()) {
  const explicit = String(env.XDG_DATA_HOME || "").trim();
  return explicit.startsWith("/") ? explicit : path.join(homedir, ".local", "share");
}

/** $XDG_DATA_DIRS, or its spec default, as absolute paths. */
function xdgDataDirs(env = process.env) {
  const raw = String(env.XDG_DATA_DIRS || "").trim() || "/usr/local/share:/usr/share";
  return raw.split(":").map((dir) => dir.trim()).filter((dir) => dir.startsWith("/"));
}

/**
 * The AppImage this process is running from, or null when self-integration
 * does not apply. The AppImage runtime exports $APPIMAGE as the absolute path
 * of the file the user launched — no other packaging sets it.
 */
function appImageSelfPath({ env = process.env, platform = process.platform } = {}) {
  if (platform !== "linux") return null;
  if (String(env.ARMADA_NO_DESKTOP_INTEGRATION || "").trim()) return null;
  const appImage = String(env.APPIMAGE || "").trim();
  return appImage.startsWith("/") ? appImage : null;
}

/**
 * Quote a path for the Exec key. The spec reserves enough characters (space,
 * quotes, `$`, `&`, `;`, …) that a downloads directory can easily contain one,
 * and quoting a path that needs no quoting is harmless.
 */
function desktopExecArg(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/(["`$])/g, "\\$1")}"`;
}

/** Escape a .desktop string value so it cannot inject further key=value lines. */
function desktopStringEscape(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function buildDesktopEntry({ appImagePath, version = "", iconName = DESKTOP_ID }) {
  // --no-sandbox mirrors the Exec line electron-builder puts in the AppImage's
  // own internal entry: chrome-sandbox needs a setuid-root binary, which no
  // AppImage can provide, so a launcher that omits it starts a process that
  // may refuse to boot on a kernel without unprivileged user namespaces.
  const exec = `${desktopExecArg(appImagePath)} --no-sandbox %U`;
  const fields = [
    ["Name", ENTRY_FIELDS.Name],
    ["Comment", ENTRY_FIELDS.Comment],
    ["Exec", exec],
    ["Terminal", "false"],
    ["Type", "Application"],
    ["Icon", iconName],
    // What makes the running window resolve to this entry. Electron's WM_CLASS
    // is app.setDesktopName() minus the .desktop suffix.
    ["StartupWMClass", DESKTOP_ID],
    ["Categories", ENTRY_FIELDS.Categories],
    [MARKER_KEY, version ? `armada-${version}` : "armada"],
    [SOURCE_KEY, appImagePath],
  ];
  return `[Desktop Entry]\n${fields
    .map(([key, value]) => `${key}=${desktopStringEscape(value)}`)
    .join("\n")}\n`;
}

/** Was this entry written by this module? Only then may it be replaced. */
function isGeneratedEntry(contents) {
  return new RegExp(`^${MARKER_KEY}=`, "m").test(String(contents));
}

/** Does any Exec line in this entry launch the given AppImage? */
function execReferences(contents, appImagePath) {
  return String(contents)
    .split(/\r?\n/)
    .some((line) => line.startsWith("Exec=") && line.includes(appImagePath));
}

async function readIfPresent(fsImpl, file) {
  try {
    return await fsImpl.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function systemEntryExists(fsImpl, env) {
  for (const dir of xdgDataDirs(env)) {
    try {
      await fsImpl.access(path.join(dir, "applications", DESKTOP_FILE));
      return true;
    } catch {
      // Not in this data dir; keep looking.
    }
  }
  return false;
}

/**
 * An entry, written by something else, that already launches this AppImage —
 * AppImageLauncher names its own `appimagekit_<hash>-Armada.desktop`. Adding
 * ours beside it would put two Armadas in the launcher.
 */
async function findForeignEntry(fsImpl, applicationsDir, appImagePath) {
  let names;
  try {
    names = await fsImpl.readdir(applicationsDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name === DESKTOP_FILE || !name.endsWith(".desktop")) continue;
    const contents = await readIfPresent(fsImpl, path.join(applicationsDir, name));
    if (contents != null && !isGeneratedEntry(contents) && execReferences(contents, appImagePath)) {
      return name;
    }
  }
  return null;
}

/** Write only when the bytes differ, so a warm start doesn't churn mtimes. */
async function writeIfChanged(fsImpl, file, data) {
  try {
    const existing = await fsImpl.readFile(file);
    if (Buffer.from(existing).equals(Buffer.from(data))) return false;
  } catch {
    // Missing or unreadable: fall through and write.
  }
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  await fsImpl.writeFile(file, data);
  return true;
}

async function installIcons({ fsImpl, dataHome, renderIcon }) {
  if (typeof renderIcon !== "function") return [];
  const written = [];
  for (const size of ICON_SIZES) {
    let png;
    try {
      png = renderIcon(size);
    } catch {
      png = null;
    }
    if (!png || png.length === 0) continue;
    const file = path.join(dataHome, "icons", "hicolor", `${size}x${size}`, "apps", `${DESKTOP_ID}.png`);
    if (await writeIfChanged(fsImpl, file, png)) written.push(file);
  }
  return written;
}

/**
 * Install (or refresh) this AppImage's desktop entry and icons.
 *
 * @param {object} [options]
 * @param {(size: number) => Buffer | null} [options.renderIcon] PNG bytes at
 *   the given square size. Omitted, only the entry is written and the icon
 *   name resolves against whatever the theme already has.
 * @returns {Promise<{ integrated: boolean, reason: string, files?: string[] }>}
 */
async function integrateAppImage({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  version = "",
  renderIcon = null,
  fsImpl = fs.promises,
} = {}) {
  const appImagePath = appImageSelfPath({ env, platform });
  if (!appImagePath) return { integrated: false, reason: "not-an-appimage" };

  try {
    if (await systemEntryExists(fsImpl, env)) {
      return { integrated: false, reason: "system-entry" };
    }

    const dataHome = xdgDataHome(env, homedir);
    const applicationsDir = path.join(dataHome, "applications");
    const entryFile = path.join(applicationsDir, DESKTOP_FILE);

    const existing = await readIfPresent(fsImpl, entryFile);
    if (existing != null && !isGeneratedEntry(existing)) {
      return { integrated: false, reason: "foreign-entry" };
    }
    if (existing == null) {
      const foreign = await findForeignEntry(fsImpl, applicationsDir, appImagePath);
      if (foreign) return { integrated: false, reason: "foreign-entry" };
    }

    const files = await installIcons({ fsImpl, dataHome, renderIcon });
    const entry = buildDesktopEntry({ appImagePath, version });
    if (await writeIfChanged(fsImpl, entryFile, entry)) files.push(entryFile);

    return files.length === 0
      ? { integrated: true, reason: "unchanged", files }
      : { integrated: true, reason: "written", files };
  } catch (error) {
    return { integrated: false, reason: "error", error };
  }
}

module.exports = {
  DESKTOP_FILE,
  DESKTOP_ID,
  ENTRY_FIELDS,
  ICON_SIZES,
  MARKER_KEY,
  appImageSelfPath,
  buildDesktopEntry,
  desktopExecArg,
  execReferences,
  integrateAppImage,
  isGeneratedEntry,
  xdgDataDirs,
  xdgDataHome,
};

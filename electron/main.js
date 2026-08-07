// Armada desktop (Electron) main process.
//
// Armada desktop is a SOVEREIGN, standalone client. It bundles the web build
// (dist/, copied in by CI) and serves it over a custom **secure** scheme
// (app://armada/…) rather than a hosted URL. This means:
//
//   • The app is not tied to any one deployment/domain. The web build is
//     compiled with EMPTY platform relays, so nothing is baked in — the user
//     adds whatever servers they want. Clients are rogue.
//   • A custom *secure* scheme is still a secure context, so the service worker
//     and Web Push (PushManager) work, and per-relay push subscriptions (whose
//     endpoints are the relays' own HTTPS origins) keep working.
//
// It also adds desktop-native behavior the web build can't: a system tray
// (close-to-tray, Show/Quit, unread badge, launch-minimized) and screen-share
// source selection (Electron has no built-in getDisplayMedia picker).

// ── Session bus repair (Linux) ──────────────────────────────────────────────
//
// Must run before anything touches Chromium. Some launchers hand us an
// environment with DBUS_SESSION_BUS_ADDRESS stripped (version-manager shims
// like asdf's `node`, which is what `npm start` goes through) — Chromium then
// marks it "disabled:" and every D-Bus consumer silently degrades. The one
// that matters is `safeStorage`: without the bus it can't reach the OS
// credential store, `isEncryptionAvailable()` is false, and the login store
// (which holds the nsec) falls back to being written in plaintext.
//
// So restore the well-known per-user socket when, and only when, the variable
// is missing AND that socket actually exists. If there is genuinely no session
// bus, nothing changes — the connection fails exactly as it did before.
if (process.platform === "linux") {
  const current = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!current || current === "disabled:") {
    const socket = `/run/user/${process.getuid()}/bus`;
    if (require("node:fs").existsSync(socket)) {
      process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socket}`;
    }
  }
}

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  protocol,
  nativeImage,
  nativeTheme,
  ipcMain,
  desktopCapturer,
  session,
  systemPreferences,
  safeStorage,
  dialog,
  powerMonitor,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const { isArmadaAppUrl } = require("./appOrigin");
const { listLinuxAudioApplications } = require("./linuxAudioSources");
const {
  detectLinuxTrayEnvironment,
  queryStatusNotifierItems,
} = require("./traySupport");
const { PushToTalkController } = require("./pushToTalk");
const createLinuxStatusNotifier =
  process.platform === "linux"
    ? require("./linuxStatusNotifier").createLinuxStatusNotifier
    : null;
const path = require("node:path");
const fs = require("node:fs");

// Keep Linux's desktop-file identity stable in both the AppImage and Flatpak.
// Electron must receive this before ready so notifications and tray hosts can
// associate the process with buzz.armada.app.desktop.
if (process.platform === "linux") {
  app.setDesktopName("buzz.armada.app.desktop");
}

// Where the bundled web build lives inside the packaged app.
const DIST = path.join(__dirname, "dist");
// Custom app scheme. Host segment "armada" keeps a stable origin
// (app://armada) for the service worker + secure-context checks.
const SCHEME = "app";
const ORIGIN = `${SCHEME}://armada`;
// Load the ROOT path, not /index.html: the SPA router has a catch-all
// `/:user` profile route, so a pathname of "/index.html" boots the app into a
// Nostr lookup for "index.html" ("No such person") instead of the app. The
// protocol handler below maps "/" to index.html.
const START_URL = `${ORIGIN}/`;

// Dark background matching the app theme (index.html theme-color #100b15).
const BACKGROUND = "#100b15";
const ICON = path.join(__dirname, "build", "icon.png");
// Tray art (electron/icon-src/tray.svg): the simplified Armada A, the same
// shape as the Android notification small icon. A tray slot is ~16-22px, so
// the full crest in ICON is unreadable there.
const TRAY_DIR = path.join(__dirname, "build");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let registeredTrayItem = null;
// Closing may hide the window only while a usable tray host exists. Linux
// desktops can accept a Tray object without displaying it (notably stock
// GNOME), so this is established through the session bus before it is trusted.
let closeToTraySupported = process.platform !== "linux";
let traySupportCheck = null;
let linuxCloseCheckInFlight = false;
let hiddenTrayMonitor = null;
// True once the user has actually chosen to quit (vs. closing to tray).
let isQuitting = false;
// True while a user-requested update check is in flight. Background checks
// stay quiet when the installed build is already current or the feed is down.
let manualUpdateCheck = false;
let updateCheckInFlight = false;
const pushToTalk = new PushToTalkController({
  platform: process.platform,
  env: process.env,
  portalFactory: () => {
    const { LinuxGlobalShortcutsPortal } = require("./linuxGlobalShortcuts");
    const shortcutIdFile = path.join(app.getPath("userData"), "push-to-talk-portal-action");
    return new LinuxGlobalShortcutsPortal({
      loadShortcutId: () => fs.readFileSync(shortcutIdFile, "utf8").trim(),
      saveShortcutId: (shortcutId) => fs.writeFileSync(shortcutIdFile, shortcutId, { mode: 0o600 }),
    });
  },
  // Prompt only when the user explicitly enables/configures push to talk.
  // macOS global input hooks require this OS-level Accessibility grant.
  isMacTrusted: () =>
    process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(true),
  sendState: (pressed) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("armada:push-to-talk-state", Boolean(pressed));
  },
  sendStatus: (status) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("armada:push-to-talk-status", status);
  },
});
// Honour --hidden / --minimized (autostart "launch minimized to tray").
const startHidden =
  process.argv.includes("--hidden") || process.argv.includes("--minimized");

// Register the custom scheme as privileged BEFORE app is ready. standard +
// secure makes it a secure context that can host a service worker; the rest
// give it normal fetch/stream/CSP behavior.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

// ── Serving the bundled SPA over app:// ──────────────────────────────────────

// Minimal extension → MIME map for the assets the SPA actually ships. The
// browser is strict about a few of these (a module script served as text/plain
// is rejected; .css with the wrong type is ignored), so we set them explicitly.
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

// Read a bundled file and return an HTTP Response. We read through Node's `fs`
// (NOT net.fetch of a file:// URL) because the web build is packaged inside
// `app.asar`: `fs` is asar-aware, while Chromium's file:// network stack is
// not — handing it `…/app.asar/dist/index.html` 404s (notably on Windows),
// which left the window blank on first open and broke boot/sync.
function serveFile(filePath) {
  try {
    const body = fs.readFileSync(filePath);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": contentTypeFor(filePath) },
    });
  } catch {
    return null;
  }
}

function registerAppProtocol() {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    // Strip query/hash, resolve within DIST, prevent path traversal.
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    const indexHtml = path.join(DIST, "index.html");
    let filePath = path.normalize(path.join(DIST, pathname));
    // Reject path traversal. Compare with a trailing separator so a sibling
    // like `<DIST>-evil` can't pass the prefix check.
    if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }

    // SPA fallback: a request without a file extension (a client route like
    // /s/<server>/<group>) serves index.html so the router can handle it.
    if (!path.extname(filePath)) {
      filePath = indexHtml;
    }

    // Serve the file; if it's missing (e.g. a route that *looked* like a file
    // because a relay param contains a dot), fall back to index.html so the
    // SPA router can resolve it instead of 404ing.
    return serveFile(filePath) ?? serveFile(indexHtml) ??
      new Response("Not Found", { status: 404 });
  });
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow({ show = !startHidden || !closeToTraySupported } = {}) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 480,
    minHeight: 600,
    show,
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    title: "Armada",
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Keep the renderer (and its live relay subscriptions / notification
      // wire) pumping while the window is hidden to tray. Without this,
      // Chromium throttles background timers and idles sockets, so
      // notifications stall for minutes until the window is refocused.
      backgroundThrottling: false,
    },
  });

  // External links (anything not on our app:// origin) open in the system
  // browser; in-app navigation stays in the window.
  const isInternal = (target) => {
    try {
      return new URL(target).origin === ORIGIN;
    } catch {
      return false;
    }
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Close → hide only when the tray is known to be visible. On Linux we
  // re-check at the moment of closing because a shell extension or tray host
  // can disappear during the session; without one, normal close quits and
  // tears down calls instead of leaving an invisible process behind.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();

    if (process.platform !== "linux") {
      if (closeToTraySupported && tray) {
        hideWindowToTray();
      } else {
        isQuitting = true;
        app.quit();
      }
      return;
    }
    if (linuxCloseCheckInFlight) return;
    linuxCloseCheckInFlight = true;
    void refreshTraySupport()
      .then((supported) => {
        if (supported) {
          hideWindowToTray();
        } else {
          isQuitting = true;
          app.quit();
        }
      })
      .finally(() => {
        linuxCloseCheckInFlight = false;
      });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(START_URL);
}

function showWindow() {
  stopHiddenTrayMonitor();
  if (!mainWindow) {
    createWindow({ show: true });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ── System tray ──────────────────────────────────────────────────────────────

// Only macOS masks a tray icon for us: a template image is re-tinted by the
// system for light/dark and for the highlighted (clicked) state. Elsewhere the
// panel gets a bitmap and draws it as authored — Electron's Tray takes a
// NativeImage, not an icon-theme NAME, so there is no symbolic recoloring to
// opt into — and we pick the variant ourselves.
function trayImage() {
  let file;
  if (process.platform === "darwin") {
    file = "trayTemplate.png";
  } else if (process.platform === "win32") {
    // The taskbar tracks the system theme, which is what nativeTheme reports.
    file = nativeTheme.shouldUseDarkColors ? "tray-white.ico" : "tray-dark.ico";
  } else {
    // Linux: white, like every other monochrome panel icon. NOT keyed to
    // nativeTheme — that is the app's GTK/color-scheme preference, and a panel
    // is styled independently of it (GNOME's top bar stays dark under a light
    // theme), so following it would paint a dark glyph onto a dark panel.
    file = "tray-white.png";
  }
  // createFromPath picks up the @2x companion for HiDPI panels on its own.
  const image = nativeImage.createFromPath(path.join(TRAY_DIR, file));
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

function trayMenuEntries() {
  return [
    { id: 1, label: "Show Armada", activate: showWindow },
    autoUpdatesSupported()
      ? {
          id: 2,
          label: "Check for Updates…",
          activate: () => void checkForDesktopUpdates(true),
        }
      : {
          id: 2,
          label:
            process.platform === "linux" && app.isPackaged
              ? "Updates are managed by your package manager"
              : "Automatic updates unavailable",
          enabled: false,
        },
    { id: 3, type: "separator" },
    {
      id: 4,
      label: "Quit",
      activate: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];
}

function buildTrayContextMenu() {
  return Menu.buildFromTemplate(
    trayMenuEntries().map(({ activate, ...entry }) => ({
      ...entry,
      id: String(entry.id),
      click: activate,
    })),
  );
}

function toggleWindowFromTray() {
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    hideWindowToTray();
  } else {
    showWindow();
  }
}

async function createTray({ statusNotifier = false } = {}) {
  if (tray && !tray.isDestroyed()) return true;
  let image = trayImage();
  if (image.isEmpty()) {
    console.warn("[tray] packaged tray icon is missing");
    return false;
  }

  if (statusNotifier && createLinuxStatusNotifier) {
    try {
      tray = await createLinuxStatusNotifier({
        image,
        tooltip: "Armada",
        getMenuEntries: trayMenuEntries,
        onActivate: toggleWindowFromTray,
        onContextMenu: (x, y) => {
          const options = {};
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            options.window = mainWindow;
          }
          if (Number.isInteger(x)) options.x = x;
          if (Number.isInteger(y)) options.y = y;
          buildTrayContextMenu().popup(options);
        },
      });
      return true;
    } catch (error) {
      tray = null;
      console.warn("[tray] failed to create StatusNotifierItem", error);
      return false;
    }
  }

  if (!image.isEmpty()) {
    image = image.resize({ width: 22, height: 22 });
  }
  try {
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  } catch (error) {
    tray = null;
    console.warn("[tray] failed to create system tray icon", error);
    return false;
  }
  if (process.platform === "win32") {
    nativeTheme.on("updated", () => {
      if (!tray || tray.isDestroyed()) return;
      tray.setImage(trayImage().resize({ width: 22, height: 22 }));
    });
  }
  tray.setToolTip("Armada");
  tray.setContextMenu(buildTrayContextMenu());
  // Left-click toggles the window (common desktop-chat behavior).
  tray.on("click", toggleWindowFromTray);
  return true;
}

function destroyTray() {
  tray?.destroy();
  tray = null;
  registeredTrayItem = null;
}

async function refreshTraySupport() {
  if (process.platform !== "linux") return closeToTraySupported;
  if (traySupportCheck) return traySupportCheck;

  traySupportCheck = detectLinuxTrayEnvironment()
    .then(async ({ supported, watcherOwned, registeredItems }) => {
      if (!supported) {
        closeToTraySupported = false;
        destroyTray();
        return false;
      }

      if (tray && !tray.isDestroyed()) {
        if (!watcherOwned || registeredItems?.includes(registeredTrayItem)) {
          closeToTraySupported = true;
          return true;
        }
        destroyTray();
      }

      const itemsBeforeCreation = new Set(registeredItems || []);
      closeToTraySupported = await createTray({ statusNotifier: watcherOwned });
      // Verify the watcher actually accepted Armada's item, not merely that a
      // host exists. This catches sandbox filters and shell incompatibilities
      // before close-to-tray can strand an invisible process. X11's legacy
      // GtkStatusIcon fallback has no watcher entry and skips this check.
      if (closeToTraySupported && watcherOwned) {
        for (let attempt = 0; attempt < 5 && !registeredTrayItem; attempt += 1) {
          const currentItems = await queryStatusNotifierItems();
          registeredTrayItem = currentItems?.find((item) => !itemsBeforeCreation.has(item)) || null;
          if (!registeredTrayItem && attempt < 4) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        if (!registeredTrayItem) {
          console.warn("[tray] StatusNotifier host did not register Armada's tray item");
          closeToTraySupported = false;
          destroyTray();
        }
      }
      return closeToTraySupported;
    })
    .catch((error) => {
      console.warn("[tray] failed to detect a Linux tray host", error);
      closeToTraySupported = false;
      destroyTray();
      return false;
    })
    .finally(() => {
      traySupportCheck = null;
    });
  return traySupportCheck;
}

function stopHiddenTrayMonitor() {
  if (!hiddenTrayMonitor) return;
  clearInterval(hiddenTrayMonitor);
  hiddenTrayMonitor = null;
}

function startHiddenTrayMonitor() {
  if (process.platform !== "linux" || hiddenTrayMonitor) return;
  hiddenTrayMonitor = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) {
      stopHiddenTrayMonitor();
      return;
    }
    void refreshTraySupport().then((supported) => {
      if (!supported && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        showWindow();
      }
    });
  }, 15_000);
  hiddenTrayMonitor.unref?.();
}

function hideWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed() || !closeToTraySupported || !tray) return;
  mainWindow.hide();
  startHiddenTrayMonitor();
}

// ── Application updates ────────────────────────────────────────────────────
//
// electron-updater supports the installed NSIS build on Windows, signed macOS
// builds, and AppImage on Linux. A portable .exe has nowhere stable to install
// an update, while deb and Flatpak packages must remain owned by their package
// manager, so those formats intentionally never contact the update feed.

function autoUpdatesSupported() {
  if (!app.isPackaged) return false;
  if (process.platform === "win32") {
    return !process.env.PORTABLE_EXECUTABLE_FILE && !process.env.PORTABLE_EXECUTABLE_DIR;
  }
  if (process.platform === "darwin") return !process.mas;
  if (process.platform === "linux") {
    return Boolean(process.env.APPIMAGE) && !process.env.FLATPAK_ID;
  }
  return false;
}

async function showUpdateMessage(options) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return dialog.showMessageBox(mainWindow, options);
  }
  return dialog.showMessageBox(options);
}

async function checkForDesktopUpdates(manual = false) {
  if (!autoUpdatesSupported()) return;
  if (updateCheckInFlight) {
    if (manual) manualUpdateCheck = true;
    return;
  }
  updateCheckInFlight = true;
  manualUpdateCheck = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    console.warn("[updater] update check failed", error);
    const shouldReport = manual && manualUpdateCheck;
    manualUpdateCheck = false;
    if (shouldReport) {
      await showUpdateMessage({
        type: "error",
        title: "Update check failed",
        message: "Armada could not check for updates.",
        detail: "Check your connection and try again.",
      });
    }
  } finally {
    updateCheckInFlight = false;
  }
}

function installAutoUpdater() {
  if (!autoUpdatesSupported()) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = console;

  autoUpdater.on("update-not-available", async () => {
    const wasManual = manualUpdateCheck;
    manualUpdateCheck = false;
    if (!wasManual) return;
    await showUpdateMessage({
      type: "info",
      title: "Armada is up to date",
      message: `You are running Armada ${app.getVersion()}, the newest available version.`,
    });
  });

  autoUpdater.on("error", async (error) => {
    console.warn("[updater] updater error", error);
    const wasManual = manualUpdateCheck;
    manualUpdateCheck = false;
    if (!wasManual) return;
    await showUpdateMessage({
      type: "error",
      title: "Update check failed",
      message: "Armada could not check for updates.",
      detail: "Check your connection and try again.",
    });
  });

  autoUpdater.on("update-downloaded", async (info) => {
    manualUpdateCheck = false;
    const { response } = await showUpdateMessage({
      type: "info",
      title: "Armada update ready",
      message: `Armada ${info.version} has been downloaded.`,
      detail: "Restart Armada to install it now, or choose Later to install when you quit.",
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });

  // Let the UI and keyring finish booting before the first network request.
  setTimeout(() => void checkForDesktopUpdates(false), 10_000);
  setInterval(() => void checkForDesktopUpdates(false), 4 * 60 * 60 * 1000);
}

// ── Unread badge ─────────────────────────────────────────────────────────────
//
// The web app reports its unread/mention count through the preload bridge
// (window.armadaDesktop.setBadge). We reflect it on the OS badge where
// supported (macOS dock, some Linux DEs via Unity launcher) and always on the
// tray tooltip + a small overlay dot.

function setUnreadBadge(count) {
  const n = Math.max(0, Number(count) || 0);

  // Cross-platform-ish: dock badge on macOS, Unity count on supported Linux.
  if (typeof app.setBadgeCount === "function") {
    app.setBadgeCount(n);
  }

  if (tray) {
    tray.setToolTip(n > 0 ? `Armada — ${n} unread` : "Armada");
  }

  // Windows taskbar overlay icon (a simple dot) when there are unread items.
  if (mainWindow && process.platform === "win32") {
    if (n > 0) {
      const dot = nativeImage.createFromDataURL(UNREAD_OVERLAY_DATA_URL);
      mainWindow.setOverlayIcon(dot, `${n} unread`);
    } else {
      mainWindow.setOverlayIcon(null, "");
    }
  }
}

// A tiny red dot PNG (16x16) for the Windows taskbar overlay.
const UNREAD_OVERLAY_DATA_URL =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#e0245e"/></svg>',
  ).toString("base64");

// ── Screen share (getDisplayMedia) ──────────────────────────────────────────
//
// Electron has no native screen-picker, so getDisplayMedia() does nothing until
// we install a request handler. We surface the available sources to the
// renderer (preload exposes pickScreenShareSource) and let the in-app UI choose,
// then hand the chosen source back to Electron.

// Keep the native DesktopCapturerSource objects from the list shown to the
// renderer. On Linux/Wayland, getSources() enters the ScreenCast portal and
// returns the ONE source the user authorized. Calling getSources() again after
// the in-app picker would start a second portal session and lose the authorized
// PipeWire stream, so the display-media handler must grant this exact object.
const screenShareSources = new Map();
const pendingScreenSharePicks = new Map();
let nextScreenSharePickId = 1;

function resolveScreenSharePick(requestId, sourceId) {
  const pending = pendingScreenSharePicks.get(requestId);
  if (!pending) return;
  pendingScreenSharePicks.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(typeof sourceId === "string" && sourceId ? sourceId : null);
}

function requestScreenSharePick() {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null);
  const requestId = nextScreenSharePickId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolveScreenSharePick(requestId, null), 5 * 60_000);
    pendingScreenSharePicks.set(requestId, { resolve, timer });
    try {
      mainWindow.webContents.send("armada:pick-screen-source", requestId);
    } catch {
      resolveScreenSharePick(requestId, null);
    }
  });
}

function installDisplayMediaHandler() {
  ipcMain.on("armada:screen-source-picked", (event, requestId, sourceId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (!Number.isSafeInteger(requestId)) return;
    resolveScreenSharePick(requestId, sourceId);
  });

  // The renderer asks for the source list and returns the chosen id; we cache
  // it for the duration of one getDisplayMedia call.
  ipcMain.handle("armada:get-screen-sources", async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 200 },
        fetchWindowIcons: true,
      });
      screenShareSources.clear();
      for (const source of sources) screenShareSources.set(source.id, source);
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail?.toDataURL() ?? "",
        appIcon:
          source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : "",
        isScreen: source.id.startsWith("screen:"),
      }));
    } catch (error) {
      screenShareSources.clear();
      console.warn("[screen-share] failed to list display sources", error);
      throw error;
    }
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // Electron's callback is one-shot and throws synchronously when an empty
      // result cancels a video request. Mark it complete BEFORE invoking it so
      // that a thrown cancellation can never result in a second callback.
      let completed = false;
      const complete = (streams, reportError = true) => {
        if (completed) return;
        completed = true;
        try {
          callback(streams);
        } catch (error) {
          if (reportError) console.warn("[screen-share] Electron rejected display source", error);
        }
      };

      // Ask the renderer to pick a source via the context-isolated preload IPC
      // bridge. A property written on preload's window is invisible to the
      // page, so executeJavaScript cannot be used to call the React handler.
      const pick = async () => {
        try {
          const chosenId = await requestScreenSharePick();
          if (!chosenId) {
            screenShareSources.clear();
            complete({}, false); // user cancelled
            return;
          }
          const source = screenShareSources.get(chosenId);
          screenShareSources.clear();
          if (!source) {
            console.warn("[screen-share] selected display source is no longer available");
            complete({}, false);
            return;
          }
          // Electron's loopback capture is Windows-only. Linux audio is added
          // by the PipeWire virtual microphone below after this video stream
          // reaches the renderer.
          complete({
            video: source,
            ...(process.platform === "win32" && request.audioRequested
              ? { audio: "loopback" }
              : {}),
          });
        } catch (error) {
          screenShareSources.clear();
          console.warn("[screen-share] display capture request failed", error);
          complete({}, false);
        }
      };
      void pick();
    },
    // useSystemPicker: true would defer to the OS picker on platforms that have
    // one (Windows/macOS recents); we use our own picker for consistency.
    { useSystemPicker: false },
  );
}

// ── Linux screen-share audio (PipeWire) ────────────────────────────────────
//
// Chromium cannot attach Linux system audio to getDisplayMedia. venmic creates
// a temporary PipeWire virtual microphone whose monitor contains either the
// selected applications or the default speakers. The renderer adds that mic's
// track to the display stream before LiveKit publishes it.

let linuxAudioPatchBay;
let linuxAudioLoadError;
const linuxAudioMatchers = new Map();

function getLinuxAudioPatchBay() {
  if (process.platform !== "linux") return null;
  if (linuxAudioPatchBay) return linuxAudioPatchBay;
  if (linuxAudioLoadError) return null;
  try {
    const { PatchBay } = require("@vencord/venmic");
    if (!PatchBay.hasPipeWire()) {
      linuxAudioLoadError = "PipeWire is not available in this session.";
      return null;
    }
    linuxAudioPatchBay = new PatchBay();
    return linuxAudioPatchBay;
  } catch (error) {
    linuxAudioLoadError = "The PipeWire audio capture module could not be loaded.";
    console.warn("[screen-share] failed to load venmic", error);
    return null;
  }
}

function electronAudioServiceMatcher() {
  const metric = app.getAppMetrics().find((entry) => entry.name === "Audio Service");
  return metric ? { "application.process.id": String(metric.pid) } : null;
}

function listLinuxAudioSources() {
  if (process.platform !== "linux") {
    return { supported: false, reason: null, sources: [] };
  }
  const patchBay = getLinuxAudioPatchBay();
  if (!patchBay) {
    return {
      supported: false,
      reason: linuxAudioLoadError || "Linux application audio requires PipeWire.",
      sources: [],
    };
  }

  try {
    const audioService = electronAudioServiceMatcher();
    const applications = listLinuxAudioApplications(
      patchBay,
      audioService?.["application.process.id"],
    );
    linuxAudioMatchers.clear();

    const sources = applications.map((source, index) => {
      const id = `app-${index}`;
      linuxAudioMatchers.set(id, source.matcher);
      return { id, name: source.name };
    });
    return { supported: true, reason: null, sources };
  } catch (error) {
    console.warn("[screen-share] failed to enumerate PipeWire audio", error);
    return { supported: false, reason: "PipeWire audio sources could not be listed.", sources: [] };
  }
}

function startLinuxShareAudio(selection) {
  const patchBay = getLinuxAudioPatchBay();
  if (!patchBay) return false;
  try {
    patchBay.unlink();
    const exclude = [];
    const audioService = electronAudioServiceMatcher();
    if (audioService) exclude.push(audioService);
    exclude.push({ "media.class": "Stream/Input/Audio" }, { "node.virtual": "true" });

    const common = {
      exclude,
      ignore_devices: true,
      only_speakers: true,
      only_default_speakers: true,
      // Stay muted until the renderer has attached the virtual microphone;
      // this avoids a short burst through the user's normal mic path.
      // venmic 6.x (used only for the Flatpak-compatible native addon) starts
      // unmuted and has no unmute() method; unknown options are harmless.
      mute: typeof patchBay.unmute === "function",
    };
    if (selection?.mode === "system") {
      return patchBay.link({ ...common, include: [] });
    }
    if (selection?.mode === "applications" && Array.isArray(selection.sourceIds)) {
      const include = selection.sourceIds
        .map((id) => linuxAudioMatchers.get(id))
        .filter(Boolean);
      if (include.length === 0) return false;
      return patchBay.link({ ...common, include });
    }
    return false;
  } catch (error) {
    console.warn("[screen-share] failed to start PipeWire audio", error);
    return false;
  }
}

function installLinuxShareAudioIpc() {
  ipcMain.handle("armada:linux-share-audio-sources", () => listLinuxAudioSources());
  ipcMain.handle("armada:linux-share-audio-start", (_event, selection) =>
    startLinuxShareAudio(selection),
  );
  ipcMain.handle("armada:linux-share-audio-unmute", () => {
    try {
      if (!linuxAudioPatchBay) return false;
      // The Flatpak-compatible venmic 6.x addon is already live after link().
      if (typeof linuxAudioPatchBay.unmute !== "function") return true;
      linuxAudioPatchBay.unmute();
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle("armada:linux-share-audio-stop", () => {
    try {
      linuxAudioPatchBay?.unlink();
    } catch (error) {
      console.warn("[screen-share] failed to stop PipeWire audio", error);
    }
  });
}

// ── Permissions (microphone/camera for voice) ───────────────────────────────
//
// Electron's default is to grant renderer permission requests, but we set an
// explicit handler so the policy is deliberate: media (mic/camera for LiveKit
// voice), notifications, fullscreen, clipboard and pointer lock are allowed
// for our own app:// origin only; everything else is denied. On macOS the OS
// additionally gates mic/camera behind TCC — the Info.plist usage strings for
// that live in electron-builder.yml (extendInfo).
//
// Windows has its own OS-level gate: Settings → Privacy → Microphone →
// "Let desktop apps access your microphone". When that's off, Chromium's
// getUserMedia rejects with NotAllowedError no matter what our handlers say,
// so the app looks "denied by default". We can't flip that toggle for the
// user, but we expose the OS access status (via getMediaAccessStatus) and a
// deep-link to the relevant Settings page (armada:mic-access-status /
// armada:open-mic-settings IPC below) so the renderer can guide them.

const ALLOWED_PERMISSIONS = new Set([
  "media", // getUserMedia (microphone + camera)
  "display-capture", // getDisplayMedia (screen share)
  "notifications",
  "fullscreen",
  "clipboard-read",
  "clipboard-sanitized-write",
  "pointerLock",
]);

function installPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const requestingUrl = details?.requestingUrl || webContents?.getURL() || "";
      callback(isArmadaAppUrl(requestingUrl) && ALLOWED_PERMISSIONS.has(permission));
    },
  );
  // Synchronous check (e.g. navigator.permissions.query, mediaDevices checks).
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) => {
      return isArmadaAppUrl(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission);
    },
  );
}

// ── Secret storage (safeStorage) ────────────────────────────────────────────
//
// The web build keeps the login store — which for an nsec login holds the raw
// secret key — in localStorage, i.e. plaintext in the profile's LevelDB. On
// desktop we can do better: `safeStorage` wraps the OS credential store
// (libsecret/kwallet on Linux, Keychain on macOS, DPAPI on Windows), so the
// blob is encrypted at rest against anything reading the profile directory.
//
// This does NOT defend against code running inside the app — the renderer can
// always ask for a decrypt, exactly as it can on the mobile keystore path.
// What it buys is at-rest protection: a stolen disk, a backup/sync tool, or
// another account on the machine no longer yields a usable nsec.
//
// The renderer owns the storage container and the migration; the main process
// only lends it the cipher. Buffers cross the bridge as base64 because the
// bridge carries JSON.

function installSecretIpc() {
  // Whether encryption is usable, plus which backend is doing it. On Linux a
  // machine with no keyring daemon falls back to `basic_text` — a hardcoded
  // key, i.e. obfuscation rather than encryption. We still use it (it costs
  // nothing and can't fail to unlock), but the renderer surfaces the backend
  // in Settings so the user isn't told they have protection they don't.
  ipcMain.handle("armada:secrets-status", () => {
    try {
      return {
        available: safeStorage.isEncryptionAvailable(),
        backend:
          process.platform === "linux"
            ? safeStorage.getSelectedStorageBackend()
            : process.platform,
      };
    } catch {
      return { available: false, backend: "unknown" };
    }
  });

  ipcMain.handle("armada:encrypt-secret", (_event, plaintext) => {
    try {
      if (typeof plaintext !== "string") return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.encryptString(plaintext).toString("base64");
    } catch {
      return null;
    }
  });

  // Returns null rather than throwing when the ciphertext can't be opened (a
  // reset keyring, a profile copied to another machine). The renderer treats
  // null as "locked, not empty" and must not overwrite the blob — it is very
  // likely the only copy of the user's identity key.
  ipcMain.handle("armada:decrypt-secret", (_event, base64) => {
    try {
      if (typeof base64 !== "string" || !base64) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(base64, "base64"));
    } catch {
      return null;
    }
  });
}

// ── Local storage (ArmadaDB over SQLite) ────────────────────────────────────
//
// Desktop stores its data the way Android does, not the way the web does: one
// SQLite file, with the query engine out here in the main process, reached by
// the renderer over IPC. `db.cjs` is the bundled build of the app's own store
// (src/lib/db — see vite.config.electron.ts), so this is the same engine and
// the same schema the test suite exercises, not a second implementation.
//
// The alternative was Chromium's IndexedDB, which is what the web build uses.
// In a browser tab that's the only option; in a desktop app it puts the user's
// messages inside a profile directory keyed by the renderer's origin, where
// they can't be found, backed up, or carried to another machine — and it ties
// their survival to a storage area the browser engine treats as evictable.
//
// The file lives in the OS's per-app config directory (app.getPath("userData"),
// i.e. ~/.config/Armada on Linux, %APPDATA%\Armada on Windows,
// ~/Library/Application Support/Armada on macOS) alongside everything else the
// app owns.

/** @type {{ call: (op: string, payload?: unknown) => Promise<unknown>, close: () => Promise<void> } | null} */
let dbServer = null;

/**
 * Narrow the store to its owner before anything opens it.
 *
 * The file holds decrypted message history, and Node creates it at the umask
 * default — 0644 on most Linux setups, i.e. readable by every other account on
 * the machine. That is the one way this store is worse than the Chromium
 * profile it replaces, and it costs two syscalls to close. It is NOT a defence
 * against malware running as the user: that process can read the file whatever
 * its mode, and could read the IndexedDB tree too.
 *
 * Done BEFORE the open because SQLite gives a new -wal/-shm the mode it finds
 * on the database, so fixing the database first fixes the pair it creates; the
 * explicit pass afterwards catches a -wal left at 0644 by an earlier build.
 *
 * Skipped on Windows, where fs.chmod only toggles the read-only flag and the
 * per-user ACL on %APPDATA% is the control that actually applies. Every step is
 * best-effort: a filesystem without POSIX modes (a FAT mount, some network
 * homes) must not cost the user their database.
 */
function restrictToOwner(file) {
  if (process.platform === "win32") return;
  const attempt = (fn) => {
    try {
      fn();
    } catch {
      // Advisory hardening; the store still opens without it.
    }
  };
  attempt(() => fs.chmodSync(path.dirname(file), 0o700));
  // Create it here if it is absent, so the mode is right from the first byte
  // rather than after a window in which it sat readable.
  attempt(() => fs.closeSync(fs.openSync(file, "a", 0o600)));
  attempt(() => fs.chmodSync(file, 0o600));
}

function installDbIpc() {
  const file = path.join(app.getPath("userData"), "armada.db");
  restrictToOwner(file);
  try {
    const { openArmadaDbServer } = require("./db.cjs");
    dbServer = openArmadaDbServer(file);
    for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
      if (process.platform === "win32") break;
      try {
        fs.chmodSync(sidecar, 0o600);
      } catch {
        // Absent (no WAL yet) or not chmod-able; neither is fatal.
      }
    }
  } catch (error) {
    // A read-only profile directory, a full disk, a database written by a
    // build whose schema this one can't open. Reported to the renderer as
    // "unavailable" rather than left to fail on first read, so it can fall
    // back to IndexedDB and still run.
    console.error("[db] could not open", file, error);
    dbServer = null;
  }

  // Answered synchronously at preload time: the renderer picks its storage
  // adapter before anything reads, so the answer has to be ready before the
  // window loads. It is — the file is opened above, during whenReady.
  ipcMain.on("armada:db-available", (event) => {
    event.returnValue = dbServer !== null;
  });

  ipcMain.handle("armada:db", async (_event, op, payload) => {
    if (!dbServer) throw new Error("The ArmadaDB store is unavailable");
    return await dbServer.call(String(op), payload ?? {});
  });
}

// Release the connection on the way out so SQLite checkpoints the WAL and the
// next launch opens a settled file rather than replaying one.
async function closeDb() {
  const server = dbServer;
  dbServer = null;
  if (!server) return;
  try {
    await server.close();
  } catch {
    // shutting down anyway
  }
}

// ── IPC from the renderer (preload bridge) ──────────────────────────────────

function installIpc() {
  ipcMain.on("armada:set-badge", (_event, count) => setUnreadBadge(count));
  ipcMain.handle("armada:platform", () => ({
    platform: process.platform,
    version: app.getVersion(),
  }));

  // OS-level microphone access status. On macOS/Windows this reflects the
  // system privacy setting (not our in-app permission handler); on Linux it's
  // always "granted". Values: "not-determined" | "granted" | "denied" |
  // "restricted" | "unknown".
  ipcMain.handle("armada:mic-access-status", () => {
    try {
      return systemPreferences.getMediaAccessStatus("microphone");
    } catch {
      return "unknown";
    }
  });

  // Open the OS microphone privacy settings so the user can allow desktop apps
  // to use the mic. No-op (resolves false) on platforms without a deep link.
  ipcMain.handle("armada:open-mic-settings", async () => {
    try {
      if (process.platform === "win32") {
        await shell.openExternal("ms-settings:privacy-microphone");
        return true;
      }
      if (process.platform === "darwin") {
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        );
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  // True hold-to-talk needs both press and release events while Armada is in
  // the background. Windows/macOS and Linux X11 use the native hook; Linux
  // Wayland/Flatpak uses the Global Shortcuts portal's Activated/Deactivated
  // signals. The renderer only marks this active while a LiveKit room exists.
  ipcMain.handle("armada:push-to-talk-configure", (_event, binding) =>
    pushToTalk.configure(binding),
  );
  ipcMain.handle("armada:push-to-talk-open-system-settings", () =>
    pushToTalk.openSystemSettings(),
  );
  ipcMain.handle("armada:push-to-talk-active", (_event, active) =>
    pushToTalk.setActive(active),
  );
}

// ── App lifecycle ────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    installPermissionHandlers();
    installIpc();
    // After whenReady: on Linux safeStorage has no key until the app is ready.
    installSecretIpc();
    // Before createWindow(): the preload asks whether the store opened, and it
    // asks synchronously, because the renderer chooses its storage adapter
    // before it reads anything.
    installDbIpc();
    installDisplayMediaHandler();
    installLinuxShareAudioIpc();
    installAutoUpdater();
    // A suspended or locked machine may never deliver the physical key-up.
    // Fail closed instead of leaving the microphone live after wake/unlock.
    powerMonitor.on("suspend", () => pushToTalk.cancelPress());
    powerMonitor.on("lock-screen", () => pushToTalk.cancelPress());
    if (process.platform === "linux") {
      await refreshTraySupport();
    } else {
      closeToTraySupported = await createTray();
    }
    // --hidden is safe only when the process has a visible way back in.
    createWindow({ show: !startHidden || !closeToTraySupported });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow({ show: true });
      else showWindow();
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
    stopHiddenTrayMonitor();
    void pushToTalk.destroy();
  });

  // Closing the database is async, and quitting is not, so the first pass is
  // deferred until the connection is released. `closeDb` clears the handle
  // before it awaits, so the re-entrant quit falls straight through.
  app.on("will-quit", (event) => {
    if (!dbServer) return;
    event.preventDefault();
    closeDb().finally(() => app.quit());
  });

  // With a usable tray, the app keeps running when all windows are closed.
  app.on("window-all-closed", () => {
    if (!closeToTraySupported) app.quit();
  });
}

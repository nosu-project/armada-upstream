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
  ipcMain,
  desktopCapturer,
  session,
  systemPreferences,
  safeStorage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");

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

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
// True once the user has actually chosen to quit (vs. closing to tray).
let isQuitting = false;
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 480,
    minHeight: 600,
    show: !startHidden,
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

  // Close → hide to tray instead of quitting (unless the user chose Quit).
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(START_URL);
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ── System tray ──────────────────────────────────────────────────────────────

function createTray() {
  let image = nativeImage.createFromPath(ICON);
  if (!image.isEmpty()) {
    image = image.resize({ width: 18, height: 18 });
  }
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("Armada");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Armada", click: showWindow },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  // Left-click toggles the window (common desktop-chat behavior).
  tray.on("click", () => {
    if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });
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

function installDisplayMediaHandler() {
  // The renderer asks for the source list and returns the chosen id; we cache
  // it for the duration of one getDisplayMedia call.
  ipcMain.handle("armada:get-screen-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail?.toDataURL() ?? "",
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : "",
      isScreen: s.id.startsWith("screen:"),
    }));
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // Ask the renderer to pick a source via the in-app picker.
      const pick = async () => {
        try {
          const chosenId = await mainWindow.webContents.executeJavaScript(
            "window.__armadaPickScreenSource && window.__armadaPickScreenSource()",
            true,
          );
          if (!chosenId) {
            callback({}); // user cancelled
            return;
          }
          const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
          });
          const source = sources.find((s) => s.id === chosenId) || sources[0];
          callback({ video: source, audio: "loopback" });
        } catch {
          callback({});
        }
      };
      pick();
    },
    // useSystemPicker: true would defer to the OS picker on platforms that have
    // one (Windows/macOS recents); we use our own picker for consistency.
    { useSystemPicker: false },
  );
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

function isAppOrigin(url) {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
}

function installPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const requestingUrl = details?.requestingUrl || webContents?.getURL() || "";
      callback(isAppOrigin(requestingUrl) && ALLOWED_PERMISSIONS.has(permission));
    },
  );
  // Synchronous check (e.g. navigator.permissions.query, mediaDevices checks).
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) => {
      return isAppOrigin(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission);
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
}

// ── App lifecycle ────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    installPermissionHandlers();
    installIpc();
    // After whenReady: on Linux safeStorage has no key until the app is ready.
    installSecretIpc();
    installDisplayMediaHandler();
    createTray();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  // With a tray, the app keeps running when all windows are closed.
  app.on("window-all-closed", () => {
    // Intentionally do nothing: the tray keeps the app alive. Quit is explicit
    // (tray menu / Cmd+Q), which sets isQuitting and lets the app exit.
  });
}

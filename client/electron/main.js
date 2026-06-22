// Armada desktop (Electron) main process.
//
// The desktop app is a thin Electron shell that loads the HOSTED Armada web
// client over HTTPS (default https://armada.dreamith.to, override at build time
// with ARMADA_APP_URL). Loading the live origin — rather than bundling the
// dist/ over file:// — keeps everything that depends on a real https origin
// working identically to the browser/PWA build:
//
//   • the service worker + Web Push notifications (Chromium refuses to register
//     a service worker on file://),
//   • window.location.origin for share / invite links,
//   • the platform-relay HTTP-origin derivation.
//
// If the origin is unreachable on launch we show a small offline page and let
// the user retry.

const { app, BrowserWindow, shell, Menu } = require("electron");

// The hosted client origin. Baked at build time via ARMADA_APP_URL; falls back
// to the public deployment.
const APP_URL = process.env.ARMADA_APP_URL || "https://armada.dreamith.to";
const APP_ORIGIN = new URL(APP_URL).origin;

// Dark background matching the app theme (index.html theme-color #100b15) so
// there is no white flash before the page paints.
const BACKGROUND = "#100b15";

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 480,
    minHeight: 600,
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    title: "Armada",
    webPreferences: {
      // No Node integration in the renderer: it loads remote web content, so
      // the renderer must stay sandboxed and context-isolated.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  // Keep in-app navigation (same origin) in the window; send everything else
  // (external links, other sites) to the user's default browser.
  const isInternal = (target) => {
    try {
      return new URL(target).origin === APP_ORIGIN;
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

  loadApp();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function loadApp() {
  if (!mainWindow) return;
  mainWindow.loadURL(APP_URL).catch(() => showOffline());
}

function showOffline() {
  if (!mainWindow) return;
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>
      html,body{height:100%;margin:0;background:${BACKGROUND};color:#e7e2ee;
        font:16px/1.5 system-ui,sans-serif;display:flex;align-items:center;
        justify-content:center;text-align:center}
      .card{max-width:28rem;padding:2rem}
      h1{font-size:1.25rem;margin:0 0 .5rem}
      p{opacity:.7;margin:0 0 1.5rem}
      button{background:#6d49cf;color:#fff;border:0;border-radius:.5rem;
        padding:.6rem 1.2rem;font-size:1rem;cursor:pointer}
    </style></head><body><div class="card">
      <h1>Can&rsquo;t reach Armada</h1>
      <p>${APP_ORIGIN} is unreachable. Check your connection and try again.</p>
      <button onclick="location.reload()" id="retry">Retry</button>
    </div>
    </body></html>`;
  mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  // Retry the real app after a short delay.
  setTimeout(loadApp, 4000);
}

// ── App lifecycle ────────────────────────────────────────────────────────────

// Single-instance: focus the existing window instead of opening a second one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // On macOS apps typically stay open until Cmd+Q.
    if (process.platform !== "darwin") app.quit();
  });
}

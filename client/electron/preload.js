// Preload bridge for the Armada desktop app.
//
// Runs in an isolated context with Node access and exposes a tiny, explicit API
// to the web app on window.armadaDesktop. The web build feature-detects this
// object: when absent (a normal browser) it no-ops; when present it lights up
// desktop-only behavior (unread badge, native screen-share picker).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("armadaDesktop", {
  /** True so the web app can detect it's running inside the desktop shell. */
  isDesktop: true,

  /** Report the current unread/mention count for the tray + OS badge. */
  setBadge: (count) => ipcRenderer.send("armada:set-badge", count),

  /** { platform, version } of the desktop shell. */
  getInfo: () => ipcRenderer.invoke("armada:platform"),

  /**
   * List shareable screens/windows for the in-app screen-share picker.
   * Returns [{ id, name, thumbnail, appIcon, isScreen }].
   */
  getScreenSources: () => ipcRenderer.invoke("armada:get-screen-sources"),

  /**
   * Register the callback the main process invokes when getDisplayMedia() is
   * called. It must resolve to the chosen source id (from getScreenSources),
   * or null/undefined to cancel. Stored on window so the main process can call
   * it via executeJavaScript.
   */
  onPickScreenSource: (handler) => {
    window.__armadaPickScreenSource = () => Promise.resolve(handler());
  },
});

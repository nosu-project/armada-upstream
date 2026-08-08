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

  /**
   * Tell the shell the web bundle actually painted. The shell serves a
   * swappable bundle from userData, and this is how it learns the one it chose
   * comes up at all — silence past a grace period makes it look for a newer
   * one immediately rather than waiting for the next scheduled check.
   */
  signalWebReady: () => ipcRenderer.send("armada:web-ready"),

  /** { platform, version } of the desktop shell. */
  getInfo: () => ipcRenderer.invoke("armada:platform"),

  /**
   * OS-level microphone access status. Reflects the system privacy setting
   * (macOS TCC / Windows "let desktop apps use the microphone"), independent of
   * our in-app permission handler. Resolves to one of: "not-determined" |
   * "granted" | "denied" | "restricted" | "unknown" (always "granted" on Linux).
   */
  getMicAccessStatus: () => ipcRenderer.invoke("armada:mic-access-status"),

  /**
   * Open the OS microphone privacy settings so the user can allow desktop apps
   * to use the mic. Resolves true if a settings page was opened, false if the
   * platform has no deep link.
   */
  openMicPrivacySettings: () => ipcRenderer.invoke("armada:open-mic-settings"),

  /**
   * Whether OS-backed secret encryption is usable, and which backend provides
   * it: { available, backend }. `backend` is the Chromium password store on
   * Linux ("gnome_libsecret" | "kwallet*" | "basic_text" | "unknown") and the
   * platform name elsewhere. "basic_text" means a hardcoded key — obfuscation,
   * not encryption.
   */
  getSecretsStatus: () => ipcRenderer.invoke("armada:secrets-status"),

  /**
   * Encrypt a string with the OS credential store. Resolves base64 ciphertext,
   * or null when encryption is unavailable (the caller then stores plaintext
   * rather than failing the write).
   */
  encryptSecret: (plaintext) => ipcRenderer.invoke("armada:encrypt-secret", plaintext),

  /**
   * Decrypt base64 ciphertext produced by encryptSecret. Resolves null when it
   * can't be opened (reset keyring, profile moved between machines) — which
   * means "locked", NOT "empty": callers must not overwrite the stored blob.
   */
  decryptSecret: (base64) => ipcRenderer.invoke("armada:decrypt-secret", base64),

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

  /**
   * The desktop ArmadaDB store: one SQLite file in the OS's per-app config
   * directory, with the query engine in the main process (see main.js).
   *
   * `available` is resolved HERE, synchronously, and not by the renderer later:
   * the web app picks its storage adapter before anything reads, so a promise
   * would be too late and a wrong guess would mean two stores. sendSync is one
   * round trip at preload, against a value the main process already computed
   * during whenReady.
   *
   * `call` dispatches one method of the store's surface — the same surface the
   * Android plugin exposes, so the web app drives both through one adapter.
   */
  armadaDb: {
    available: ipcRenderer.sendSync("armada:db-available") === true,
    call: (op, payload) => ipcRenderer.invoke("armada:db", op, payload),
  },
});

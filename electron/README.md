# Armada desktop (Electron)

A **standalone, sovereign** Armada client. It bundles the web build (`dist/`,
copied in by CI) and serves it over a custom **secure** scheme (`app://armada/…`)
rather than loading a hosted URL. Consequences:

- **Not tied to any domain.** The bundled web build bakes in no servers at all —
  the user adds whatever servers they want. Clients are rogue.
- A custom *secure* scheme is still a secure context, so the **service worker**
  and **Web Push** work, and per-relay push subscriptions (whose endpoints are
  the relays' own HTTPS origins) keep working — unlike a plain `file://` bundle,
  where Chromium refuses to register a service worker.

It also adds desktop-native behavior the web build can't:

- **System tray** — close-to-tray, a Show / Quit menu, click-to-toggle, an
  unread badge (tray tooltip + macOS dock + Windows taskbar overlay), and a
  `--hidden`/`--minimized` flag to launch minimized (for autostart).
- **Screen-share picker** — Electron has no built-in `getDisplayMedia` picker,
  so the main process enumerates sources and the in-app `ScreenSharePicker`
  dialog lets the user choose a screen/window.
- **Encrypted login store** — the web build keeps the login blob (which for an
  nsec login holds the raw secret key) in plaintext `localStorage`. Here it is
  encrypted at rest with `safeStorage`, i.e. the OS credential store
  (libsecret/kwallet, Keychain, DPAPI). This is at-rest protection only — it
  stops a stolen disk, a backup tool, or another account on the machine, not
  code running inside the app. Notes:
  - The value stays in `localStorage`; only its contents are ciphertext, in a
    `{"v":1,"enc":"safeStorage","data":…}` envelope (`src/lib/secureStorage.ts`).
    An empty login list is stored as literal `[]` — nothing secret in it, and
    `index.html`'s inline boot script reads this key synchronously to decide
    whether to draw the crest.
  - Migration is lazy, on first successful read. If the credential store is
    unavailable the adapter writes plaintext rather than failing the write.
  - A blob that won't decrypt (reset keyring, profile copied to another
    machine) means *locked*, not *empty*: it is copied to `armada:login-locked`
    before the signed-out UI can overwrite it, since it may be the only copy of
    the user's key.
  - On Linux, `main.js` restores `DBUS_SESSION_BUS_ADDRESS` from
    `/run/user/<uid>/bus` when the launcher stripped it. Version-manager shims
    do this — asdf's `node` shim drops it, and `npm start` runs through that
    shim — which leaves Chromium with `disabled:`, no reachable secret
    service, and a login store silently written in plaintext. Packaged builds
    exec the binary directly and were never affected, which is what makes this
    a dev-launch trap specifically.
  - On Linux with no keyring daemon, Chromium selects the `basic_text` backend
    — a hardcoded key, so obfuscation rather than encryption. The backend is
    reported in Settings → Keys so the user isn't told they have protection
    they don't.

The web client talks to the shell through a small, explicit bridge
(`window.armadaDesktop`, see `preload.js`); on the web that object is absent and
every integration no-ops.

## Local build / run

```sh
# 1. Build the standalone web bundle and stage it.
cd client
npx vite build
rm -rf electron/dist && cp -r dist electron/dist

# 2. Build / run the desktop app.
cd electron
npm install
npm start            # run the bundled app

# Package installers (output in release/):
npm run dist:linux   # AppImage + deb
npm run dist:win     # NSIS installer + portable .exe (needs wine on Linux)
npm run dist:mac     # .dmg (must run on macOS)

# macOS .app bundles from any OS, after a dist:linux (see below):
node scripts/package-mac.mjs
```

The app icon lives at `build/icon.png` (1024×1024, committed); electron-builder
derives `.ico`/`.icns` from it.

The tray icon is separate art — the simplified Armada A, the same shape as the
Android notification small icon — because the crest is illegible in a ~16px
panel slot. Source: `icon-src/tray.svg`, with the regeneration commands in its
comment. Only macOS masks a tray icon for you (`build/trayTemplate.png` +`@2x`,
marked as a template image); a Linux or Windows panel is handed a bitmap and
draws it as authored, so the variants are picked in `main.js`:
`build/tray-white.png` (+`@2x`) on Linux, and `build/tray-white.ico` /
`build/tray-dark.ico` on Windows, swapped on `nativeTheme` updates since the
taskbar follows the system theme. Linux deliberately does *not* follow
`nativeTheme` — that is the app's color-scheme preference, and panels are
styled independently of it.

Both the tray art and the window icon are loaded at runtime, so `build/**/*` is
listed in `electron-builder.yml`'s `files`.

## CI

`.ngit/act/workflows/desktop.yml`, on version tags (`vX.Y.Z`). One job builds
the web bundle (with no servers baked in) and then all three platforms from a
single Linux container, publishing each file twice: as ngit-ci run artifacts,
and by rsync into the web deploy's `downloads/` directory, so every build has a
stable URL like `https://armada.buzz/downloads/Armada-v1.2.3.AppImage`.

| File | Built by |
|------|----------|
| `Armada-vX.Y.Z.AppImage`, `.deb` | electron-builder `--linux` |
| `Armada-vX.Y.Z.exe` (NSIS), `-portable.exe` | electron-builder `--win`, via wine |
| `Armada-vX.Y.Z-mac-x64.zip`, `-mac-arm64.zip` | `scripts/package-mac.mjs` + rcodesign |

### macOS is cross-built

There is no macOS runner (ngit-ci executes Linux containers), and
electron-builder refuses mac targets off darwin. But that refusal is about
*signing*, not about the bundle: a `.app` is the prebuilt darwin Electron with
our `app.asar` in `Contents/Resources` and a rewritten `Info.plist`, which
`@electron/packager` assembles anywhere. `scripts/package-mac.mjs` does that,
reusing the asar electron-builder staged for Linux — so the mac bundles ship
byte-identical app code, with no second file list to drift. That reuse holds
only while the app has no native modules (it has no runtime `dependencies` at
all).

Two Apple-only pieces are handled honestly rather than faked:

- **Signing.** An arm64 Mac won't exec a binary with *no* signature, so CI
  ad-hoc signs with [rcodesign](https://github.com/indygreg/apple-platform-rs),
  which runs off darwin. That makes the app launchable, not trusted: it is
  neither Developer ID signed nor notarized, so a first open still needs
  System Settings → Privacy & Security → Open Anyway. Real signing needs Apple
  credentials — either electron-builder on a Mac (`CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`) or rcodesign with a `.p12` plus an App Store Connect key.
- **`.zip`, not `.dmg`.** A disk image needs HFS+ tooling that isn't in the
  container (Firefox cross-builds `.dmg` on Linux with `libdmg-hfsplus`, if
  that's ever wanted). Zip is a first-class macOS distribution format — it's
  what Electron's own auto-updater consumes — and an unsigned `.dmg` would buy
  nothing but the drag-to-Applications ritual.

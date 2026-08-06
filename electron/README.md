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
```

The app icon lives at `build/icon.png` (1024×1024, committed); electron-builder
derives `.ico`/`.icns` from it.

The tray icon is separate art — the simplified Armada A, the same shape as the
Android notification small icon — because the crest is illegible in a ~16px
panel slot. Source: `icon-src/tray.svg`, with the regeneration commands for
`build/tray.png` (+`@2x`), `build/tray.ico` (Windows) and
`build/trayTemplate.png` (+`@2x`, the macOS menu-bar template) in its comment.
Both icons are loaded at runtime, so `build/**/*` is listed in
`electron-builder.yml`'s `files`.

## CI

`.gitlab-ci.yml`, on version tags (`vX.Y.Z`):

- `build-desktop-web` builds the web bundle once (empty platform relays) and
  passes `electron/dist/` to the platform jobs as an artifact.
- `build-desktop-linux` / `build-desktop-windows` package the installers, upload
  them to the generic package registry, and the `release` job links them on the
  GitLab Release — alongside the Android APK/AAB.
- `build-desktop-macos` is a manual, `allow_failure` job that needs a runner
  tagged `macos`.

### macOS signing (optional)

Unsigned `.dmg` builds run only after a Gatekeeper override (right-click → Open).
For a distributable build, add the standard electron-builder signing secrets as
CI/CD variables: `CSC_LINK`, `CSC_KEY_PASSWORD`, and for notarization
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

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

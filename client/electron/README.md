# Armada desktop (Electron)

A thin Electron shell that loads the **hosted** Armada web client over HTTPS
(default `https://armada.dreamith.to`). It deliberately does **not** bundle the
web build over `file://` — loading the real origin keeps everything that needs a
true https origin working exactly like the browser/PWA build:

- the service worker + **Web Push notifications** (Chromium won't register a
  service worker on `file://`),
- `window.location.origin` for share / invite links,
- the platform-relay HTTP-origin derivation.

If the origin is unreachable on launch, a small offline page is shown and the
app retries.

## Configure which origin it loads

Set `ARMADA_APP_URL` when building (baked into `main.js` at runtime via env):

```sh
ARMADA_APP_URL=https://armada.example.com npm run dist:linux
```

Defaults to `https://armada.dreamith.to`.

## Local build / run

```sh
cd client/electron
npm install

# Run against the default (or a custom) origin without packaging:
ARMADA_APP_URL=https://armada.dreamith.to npm start

# Package installers (output in dist/):
npm run dist:linux   # AppImage + deb
npm run dist:win     # NSIS installer + portable .exe (needs wine on Linux)
npm run dist:mac     # .dmg (must run on macOS)
```

The app icon is generated from `../public/logo.svg` into `build/icon.png`
(1024×1024); electron-builder derives `.ico`/`.icns` from it. CI generates this;
locally, create it yourself if you want a custom icon:

```sh
mkdir -p build && rsvg-convert -w 1024 -h 1024 ../public/logo.svg -o build/icon.png
```

## CI

`.gitlab-ci.yml` builds Linux + Windows desktop installers on version tags
(`vX.Y.Z`), uploads them to the generic package registry, and links them on the
GitLab Release — alongside the Android APK/AAB. macOS is a manual,
`allow_failure` job that needs a runner tagged `macos`.

### macOS signing (optional)

Unsigned `.dmg` builds run only after a Gatekeeper override (right-click → Open).
For a distributable build, add the standard electron-builder signing secrets as
CI/CD variables: `CSC_LINK`, `CSC_KEY_PASSWORD`, and for notarization
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

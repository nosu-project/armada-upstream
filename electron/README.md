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
- **Screen and application sharing** — the in-app picker can switch the active
  screen/window without ending the share. Windows captures system audio;
  Linux uses PipeWire plus `@vencord/venmic` for either the entire system or a
  selected application's audio.
- **Global push to talk** — Windows, macOS and X11 use `uiohook-napi`; Wayland
  uses the trusted Global Shortcuts portal, including sandboxed Flatpak builds.
- **Package-aware updates** — installed Windows and AppImage editions update
  themselves. Portable, deb and Flatpak builds defer to their actual package
  owner, and the tray explains when the in-app updater is unavailable.
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

## Development

```sh
npm run electron:dev     # from the repo root
```

`scripts/dev-electron.sh` starts the Vite dev server and launches this shell
against it (`ARMADA_DEV_URL`), so the renderer has HMR and React fast refresh
while the main process is the same `main.js` the packaged app runs — tray,
screen picker, `safeStorage`, the SQLite store all behave as they do in a
build. Ctrl-C stops both. `PORT` overrides 8080; F12 / Ctrl+Shift+I open the
inspector (the app menu is removed, so the default accelerators are gone with
it).

Two things dev mode does *not* share with an installed Armada, both deliberate:
the **profile** (`--user-data-dir` points at `electron/.dev-profile`, so a
work-in-progress build can't write the real `armada.db`; set
`ARMADA_DEV_USER_DATA` if you want the real one), and the **origin**
(`http://localhost:8080` vs `app://armada`, and localStorage — hence the login
store — is per-origin, so you log in again here).

## Local build / run

```sh
# From the repository root:
npm ci
cd electron
npm ci
npm start            # builds web + electron/db.cjs, stages, then launches

# Package installers (output in release/):
npm run dist:linux   # AppImage + deb
npm run dist:win     # NSIS installer + portable .exe (needs wine on Linux)
npm run dist:mac     # .dmg (must run on macOS)

# macOS .app bundles from any OS, after a dist:linux (see below):
node scripts/package-mac.mjs
```

The Electron lifecycle scripts always rebuild and stage both the web client and
the desktop ArmadaDB bridge (`main.js` requires `db.cjs` at startup and it is
gitignored). This prevents a current shell from being paired with a stale
renderer or silently falling back to a different storage engine.

The app icon lives at `build/icon.png` (1024×1024, committed); electron-builder
derives `.ico`/`.icns` from it. Linux uses `build/linux-icon.png` instead — the
crest on the cut-corner tile the UI gives server icons — as both the packaged
launcher icon (`linux.icon`) and the *window* icon, because on Linux the window
icon is what a dock draws whenever it cannot match the window to an installed
`.desktop` entry.

That case is the AppImage, and `desktopIntegration.js` is the other half of the
fix: the deb and the Flatpak install an entry, an AppImage run from
`~/Downloads` has none, and a desktop environment with no entry to match falls
back to naming the app after its WM_CLASS — `buzz.armada.app` in the dock
tooltip. So the AppImage writes its own entry (and hicolor icons) into
`XDG_DATA_HOME` at launch, with the same id, `Name` and `StartupWMClass` the
packaged entries use. It only ever writes when `$APPIMAGE` is set, never
replaces an entry it did not write itself (AppImageLauncher's, or a
hand-edited one), stands down when a system-wide entry exists, and is disabled
entirely by `ARMADA_NO_DESKTOP_INTEGRATION=1`.

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

Linux uses StatusNotifierItem on desktops with a watcher (including KDE and a
GNOME AppIndicator extension). Stock GNOME has no visible tray host. Armada
verifies its own registration before allowing close-to-tray; without a usable
host the close button exits instead of leaving calls running in an invisible
process. Non-GNOME X11 desktops may use Electron's legacy tray fallback.

## Push to talk

Enable push to talk and record a physical key under Settings → Voice. The
binding is per-device. Armada registers it globally but only forwards it to
LiveKit while a call is connected; release, disconnect, binding changes and app
shutdown all fail closed to a muted microphone.

macOS requests Accessibility access for the native global hook. X11 uses that
same hook. On Wayland the desktop portal owns the authoritative assignment:
KDE's version-2 portal exposes its shortcut editor, while GNOME's version-1
portal reopens the trusted chooser by replacing the portal action. COSMIC's
current native portal does not implement Global Shortcuts, so Armada reports
it as unsupported rather than falling back to a shortcut that works only while
the app is focused.

## Update ownership

Every edition has exactly one update owner:

| Edition | Update mechanism |
| --- | --- |
| Windows NSIS installer | Armada downloads and installs from `/desktop` |
| Windows portable / Store | Replace manually / Microsoft Store |
| Developer ID–signed macOS build | Armada consumes the signed zip feed |
| CI cross-built ad-hoc macOS zip | Replace manually; marked no-self-update |
| Linux AppImage | Armada replaces the running AppImage from `/desktop` |
| Linux deb | apt/dpkg repository; in-app updater disabled |
| Linux Flatpak | configured Flatpak remote; in-app updater disabled |

`electron-builder.yml` points `electron-updater` at
`https://armada.buzz/desktop`. Tagged CI releases deploy the exact NSIS and
AppImage basenames referenced by `latest.yml` and `latest-linux.yml`, plus
their blockmaps, before deploying the mutable metadata. CI validates every
metadata reference first.

Production Windows releases should provision `WINDOWS_CSC_LINK` and
`WINDOWS_CSC_KEY_PASSWORD` so the installer and subsequent updates retain one
publisher identity. macOS self-update requires a native macOS build signed with
a Developer ID Application certificate and a consistently signed updater zip;
the Linux cross-build is only ad-hoc signed and carries
`armada-no-self-update` for that reason.

## Flatpak

The manifest is `flatpak/buzz.armada.app.yml`. It wraps the already-built
AppImage with Electron BaseApp and grants PipeWire audio and the narrow session
bus permissions needed for screen audio, the shortcut portal and tray
registration.

Install the builder and runtimes (Debian/Ubuntu example):

```sh
sudo apt install flatpak flatpak-builder
flatpak remote-add --user --if-not-exists flathub \
  https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub \
  org.freedesktop.Platform//25.08 \
  org.freedesktop.Sdk//25.08 \
  org.electronjs.Electron2.BaseApp//25.08
```

On an immutable host, install Builder itself as a Flatpak instead:

```sh
flatpak install --user flathub org.flatpak.Builder
```

Then build both the single-file bundle and update repository:

```sh
cd electron
npm run dist:linux
npm run dist:flatpak
flatpak install --user ./release/Armada-flatpak-x86_64.flatpak
```

For a local package-manager update cycle:

```sh
flatpak remote-add --user --no-gpg-verify armada-local \
  "file://$PWD/release/flatpak-repo"
flatpak install --user armada-local buzz.armada.app
flatpak update --user buzz.armada.app
```

Tagged releases publish that OSTree repository at
`https://armada.buzz/flatpak/`. Until its exports are GPG-signed, a test remote
must be added with `--no-gpg-verify`; production distribution should set
`FLATPAK_GPG_KEY` and distribute the matching public key. The manifest swaps
only venmic's native prebuild to its Freedesktop-25.08-compatible 6.1 build;
AppImage and deb retain the lockfile-pinned 7.x build.

## CI

`.ngit/act/workflows/desktop.yml`, on version tags (`vX.Y.Z`). One job builds
the web bundle and desktop DB bridge, then every published platform from a
single Linux container. Human installers are copied to `/downloads`; updater
payloads retain their electron-builder names under `/desktop`; the Flatpak
OSTree repository is published under `/flatpak`.

| File | Built by |
|------|----------|
| `Armada-vX.Y.Z.AppImage`, `.deb` | electron-builder `--linux` |
| `Armada-vX.Y.Z.flatpak` | Flatpak Builder from that AppImage |
| `Armada-vX.Y.Z.exe` (NSIS), `-portable.exe` | electron-builder `--win`, via wine |
| `Armada-vX.Y.Z-mac-x64.zip`, `-mac-arm64.zip` | `scripts/package-mac.mjs` + rcodesign |

### macOS is cross-built

There is no macOS runner (ngit-ci executes Linux containers), and
electron-builder refuses mac targets off darwin. But that refusal is about
*signing*, not about the bundle: a `.app` is the prebuilt darwin Electron with
our `app.asar` in `Contents/Resources` and a rewritten `Info.plist`, which
`@electron/packager` assembles anywhere. `scripts/package-mac.mjs` does that,
reusing the asar electron-builder staged for Linux — so the mac bundles ship
byte-identical app code, with no second file list to drift. `uiohook-napi`
ships all supported N-API prebuilds together; the script explicitly copies its
electron-builder-generated `app.asar.unpacked` payload because prebuilt-asar
packaging does not do so automatically. Linux-only venmic is not copied.

Two Apple-only pieces are handled honestly rather than faked:

- **Signing.** An arm64 Mac won't exec a binary with *no* signature, so CI
  ad-hoc signs with [rcodesign](https://github.com/indygreg/apple-platform-rs),
  which runs off darwin. That makes the app launchable, not trusted: it is
  neither Developer ID signed nor notarized, so a first open still needs
  System Settings → Privacy & Security → Open Anyway. Real signing needs Apple
  credentials — either electron-builder on a Mac (`CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`) or rcodesign with a `.p12` plus an App Store Connect key.
- **Updates.** The ad-hoc archive is explicitly marked manual-update. A native,
  Developer ID–signed electron-builder release omits that marker and can use a
  signed `latest-mac.yml` + zip feed when those files are deployed.
- **`.zip`, not `.dmg`.** A disk image needs HFS+ tooling that isn't in the
  container (Firefox cross-builds `.dmg` on Linux with `libdmg-hfsplus`, if
  that's ever wanted). Zip is a first-class macOS distribution format — it's
  what Electron's own auto-updater consumes — and an unsigned `.dmg` would buy
  nothing but the drag-to-Applications ritual.

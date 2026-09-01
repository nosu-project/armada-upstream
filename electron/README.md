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
  selected application's audio. Resolution, frame rate, bitrate, codec and
  delivery mode are configurable, and either side can open live stream details
  or make the shared content genuinely full-screen.
- **Global push to talk** — Windows, macOS and X11 use `uiohook-napi`; Wayland
  uses the trusted Global Shortcuts portal, including sandboxed Flatpak builds.
- **Package-aware updates** — installed Windows, AppImage and Flatpak editions
  update themselves; portable and deb builds defer to their actual package
  owner. The Flatpak notices a release from the same signed event as the
  others, then installs and restarts through the Flatpak update portal — from
  the GPG-verified origin remote, with no sandbox permission spent on it.
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
npm start            # builds web + db.cjs + updateFeed.cjs, stages, then launches

# Package installers (output in release/):
npm run dist:linux   # AppImage + deb
npm run dist:win     # NSIS installer + portable .exe (needs wine on Linux)
npm run dist:mac     # .dmg (must run on macOS)

# macOS .app bundles from any OS, after a dist:linux (see below):
node scripts/package-mac.mjs
```

The Electron lifecycle scripts always rebuild and stage the web client and both
`src/`-derived main-process bundles — the ArmadaDB bridge (`db.cjs`, required at
startup) and the updater's release feed (`updateFeed.cjs`). Both are gitignored
build artifacts. This prevents a current shell from being paired with a stale
renderer, silently falling back to a different storage engine, or checking for
updates through a stale copy of the release-event parser.

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

## Screen-share quality and codecs

The screen-share dialog controls the requested output resolution, frames per
second, maximum bitrate, codec and delivery mode. The bitrate is an encoder
ceiling rather than a promise that static content will consume every bit. The
stream-details dialog reports the measured encoded rate and input cadence; a
`missed` frame is a capture deadline for which no fresh frame arrived, not a
frame that was encoded and then lost on the network.

VP8 is the compatibility fallback. Encrypted H.264 prefers packetization mode
1 and, on Linux, can use the software compatibility path when the platform
encoder is not interoperable. Standard H.265 is exposed only when Chromium
reports an encoder for the current Windows or macOS machine, so there is no
separate FFmpeg helper to install on those systems. A receiver must also have
H.265 decoding support; older Armada builds that do not negotiate H.265 need
to be updated or should receive VP8/H.264 instead.

Chromium does not expose H.265 WebRTC encoding on Linux, so Armada has a
Linux-only E2EE pipeline: Electron captures the trusted picker selection,
FFmpeg encodes HEVC Main through VA-API, and the bundled
`armada-hevc-publisher` sends the pre-encoded track through LiveKit. The
publisher is packaged into AppImage, deb and Flatpak builds from one generated
binary; it is deliberately excluded from Windows and macOS packages. Its
auxiliary LiveKit identity is authenticated by signed Concord presence and is
folded into the presenter's tile rather than shown as another caller.

For AppImage and deb, the host must provide an FFmpeg build with
`hevc_vaapi`, an HEVC-capable VA-API driver, and access to a
`/dev/dri/renderD*` node. Capability detection runs a small real encode probe
and reports the failing driver/device instead of offering a broken choice.
The Flatpak uses its Freedesktop runtime FFmpeg/VA-API stack and grants render
device access in the manifest. Do not bundle an arbitrary static FFmpeg for
AppImage: VA-API must load the host's matching libva/libdrm driver stack.

Build the publisher with the Go version declared in
`hevc-publisher/go.mod`:

```sh
cd electron
./scripts/build-hevc-publisher.sh --arch x64
```

The script vendors dependencies in a temporary directory, applies the local
LiveKit primary-codec metadata patch, runs the Go tests, and stages a static
binary under `generated/hevc/x64/`. `npm run dist:linux` performs this step
automatically before electron-builder packages the AppImage and deb; the
Flatpak is then built from that AppImage so their publisher and renderer cannot
drift.

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
| Windows NSIS installer | Armada downloads and installs from the release event |
| Windows portable / Store | Replace manually / Microsoft Store |
| Developer ID–signed macOS build | Armada consumes the signed zip from the release event |
| CI cross-built ad-hoc macOS zip | Replace manually; marked no-self-update |
| Linux AppImage | Armada replaces the running AppImage from the release event |
| Linux deb | Download and install the newer deb; in-app updater disabled |
| Linux Flatpak | Armada installs from the embedded GPG-verified remote via the update portal and restarts itself; `flatpak update` also works |

### The feed is the release event

The updater reads the same NIP-34 kind-30622 release event `/downloads` renders
— see `docs/releases.md` — not a `latest*.yml` on a web server. The pieces:

| File | Role |
| --- | --- |
| `src/lib/desktopUpdate.ts` | queries the relays, verifies, picks this platform's artifact |
| `electron/updateFeed.cjs` | that file bundled for the main process (gitignored build artifact) |
| `electron/nostrUpdateProvider.js` | wraps it as an electron-updater `custom` provider |
| `electron/main.js` | `setFeedURL({ provider: "custom", updateProvider: … })` |

Nothing here reimplements downloading or installation — `NsisUpdater`,
`AppImageUpdater` and `MacUpdater` still do all of that. The provider answers
only "what is the latest version" and "where are its bytes".

Two consequences worth knowing before changing any of it:

- **The download URL deliberately drops the Blossom extension.**
  electron-updater names the cached file after the URL's basename when the URL
  ends in the expected extension, and otherwise after `UpdateFileInfo.url`,
  where the provider puts the real filename. A Blossom basename is a hash, and
  on Linux the cache name becomes the *installed* name — so with the extension
  left on, updating would rename the user's AppImage to `3f9ac2….AppImage`.
- **Differential download is off.** A blockmap is different bytes, so a
  different hash, at a URL the event does not name. Leaving it on would cost a
  guaranteed-404 request per check before full-downloading anyway.

This is a stronger trust boundary than the static feed it replaced. The artifact
is content-addressed and named by an event signed by a build-pinned maintainer
key (`RELEASE_AUTHORS`), so a compromised web host can no longer serve a
different binary — the previous arrangement's weakest point, and it was the half
that executes what it downloads. Signature, author and repository are all
checked before a URL is used; a relay is untrusted transport.

### The static feed is gone

No `latest*.yml` is generated (`publishAutoUpdate: false`) and nothing for the
desktop is published over SSH. The `publish:` block in `electron-builder.yml`
stays only because electron-builder packages `app-update.yml` only when one
exists, and electron-updater reads that file on every download; its `url:` is
never fetched.

**Installs from v0.56.3 and earlier cannot auto-update.** They have the old feed
URL compiled in, and it is no longer refreshed, so they report "Armada is up to
date" indefinitely. Recovery is a manual download from `/downloads`. The retired
feed files are still on the server — nothing deletes them; remove them by hand
whenever you like.

Windows signing remains recommended: provisioning `WINDOWS_CSC_LINK` and
`WINDOWS_CSC_KEY_PASSWORD` gives the installer and subsequent updates one
publisher identity and improves SmartScreen reputation. It is not required for
self-update. An installed unsigned NSIS build uses the same trust boundary as
the AppImage: HTTPS protects delivery, and electron-updater checks the
downloaded file against the `x` sha256 the release event declares, which is also
the artifact's Blossom content address.

macOS self-update does require a native macOS build signed with a Developer ID
Application certificate and a consistently signed updater zip; the Linux
cross-build is only ad-hoc signed and carries `armada-no-self-update` for that
reason.

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

After the first signed Flatpak release is live, most users should install the
stable standalone bundle. A signed release bundle embeds both the Armada
repository URL and its public key, so installing it automatically creates a
GPG-verified origin; do not add an unsigned remote first:

```sh
curl --fail --location --output Armada.flatpak \
  https://armada.buzz/downloads/Armada.flatpak
flatpak install --user ./Armada.flatpak
flatpak run buzz.armada.app
```

Future releases use Flatpak's normal package-manager update path either way:

```sh
flatpak update --user buzz.armada.app
```

Armada also updates itself, like the other self-updating editions. It reads
the same signed kind-30622 release event every other edition reads to notice a
newer version, then asks the Flatpak update portal
(`org.freedesktop.portal.Flatpak`, reachable from every sandbox with no
finish-args grant) to deploy the newer commit from this GPG-verified origin
remote and to spawn a fresh instance on the new deploy — the running process
keeps its old `/app` mount until it exits, which is why a plain relaunch could
never land on the update. The bytes installed this way come exclusively from
the signed OSTree repository; the release event is detection only. Two
consequences worth knowing: the portal refuses an update whose permissions
grew, so a release that adds a finish-args entry updates through
`flatpak update` instead, and the desktop may show a one-time "Update Armada?"
consent dialog the first time. See `electron/flatpakUpdate.js`.

Armada itself comes from that origin, not Flathub. Its Freedesktop and Electron
runtimes still need a configured Flathub remote; most Flatpak installations
already have one. If needed, add it first with the `flathub` command in the
builder setup above.

To install directly from the hosted repository instead, wait until that signed
release is live, then download its public key and the machine-readable copy of
its full primary-key fingerprint:

```sh
curl --fail --location --output armada-flatpak.gpg \
  https://armada.buzz/downloads/flatpak/armada-flatpak.gpg
curl --fail --location --output armada-flatpak.fingerprint \
  https://armada.buzz/downloads/flatpak/armada-flatpak.fingerprint
gpg --show-keys --with-fingerprint ./armada-flatpak.gpg
cat ./armada-flatpak.fingerprint
```

Both of those files come from one HTTPS host, so comparing only those files
does not authenticate the key — it proves that whoever serves armada.buzz
agrees with themselves. The independent channel is the **nsite manifest**: the
same fingerprint ships in the static build at
`/.well-known/armada-flatpak.fingerprint`, and every path in that build is
committed by sha256 in a Nostr event signed by Armada's publishing key. Check
the downloaded key against that instead, with
[`nak`](https://github.com/fiatjaf/nak) and `jq`:

```sh
armada_npub=npub10qdp2fc9ta6vraczxrcs8prqnv69fru2k6s2dj48gqjcylulmtjsg9arpj
curl --fail --location --output armada-flatpak.announced \
  https://armada.buzz/.well-known/armada-flatpak.fingerprint

# The newest site manifest signed by that key, verified, then the sha256 it
# commits the announcement file to.
nak req -k 35128 -a "$armada_npub" -d armada \
  wss://relay.ditto.pub wss://relay.dreamith.to wss://relay.primal.net |
  jq -s 'max_by(.created_at)' > armada-nsite.json
nak verify < armada-nsite.json
jq -r '.tags[] | select(.[0] == "path")
       | select(.[1] == "/.well-known/armada-flatpak.fingerprint") | .[2]' \
  < armada-nsite.json
sha256sum ./armada-flatpak.announced
```

`nak verify` must exit 0, the two hashes must match, and
`armada-flatpak.announced` must then equal both `armada-flatpak.fingerprint`
and the first fingerprint `gpg --show-keys` printed for the `pub` key. Do not
substitute a short key ID or a fingerprint copied from this README. The
manifest is addressed by the coordinate
`35128:781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5:armada`,
which is the same identity that signs this repository — so the check is
independent of the web server, not of Armada. Once verified, add the remote and
import that key:

```sh
flatpak remote-add --user --if-not-exists \
  --gpg-import=./armada-flatpak.gpg \
  armada https://armada.buzz/downloads/flatpak/
flatpak remote-modify --user --enable --gpg-verify \
  --gpg-import=./armada-flatpak.gpg \
  --url=https://armada.buzz/downloads/flatpak/ armada
flatpak install --user armada buzz.armada.app
flatpak run buzz.armada.app
```

The `remote-modify` line also repairs an `armada` remote created from the
older `/flatpak/` instructions; `remote-add --if-not-exists` alone would retain
its previous URL and trust settings.

### Migrating an existing unsigned installation

Releases before repository signing created a `no-gpg-verify` origin, commonly
named `app-origin`. A non-root process cannot pull unverified content into the
system-wide Flatpak installation, which produces `Can't pull from untrusted
non-gpg verified remote` in graphical updaters and system upgrade tools. Until
the first signed release is live, update only Armada from a terminal with:

```sh
sudo flatpak update --system buzz.armada.app
```

That is a temporary workaround, not signature verification: the unsigned
release is still trusted through HTTPS and the deployment host. In particular,
do **not** turn on `--gpg-verify` yet. An unsigned summary cannot satisfy it and
would leave the origin unable to update.

The recommended long-term layout is a per-user Armada installation. It avoids
the privileged system helper and matches the commands on the downloads page.
Close Armada, download and verify the user installation, then remove the old
system deployment:

```sh
curl --fail --location --output Armada.flatpak \
  https://armada.buzz/downloads/Armada.flatpak
flatpak install --user ./Armada.flatpak
flatpak info --user buzz.armada.app
armada_system_origin="$(flatpak info --system --show-origin buzz.armada.app)"
sudo flatpak uninstall --system buzz.armada.app
```

Optionally launch it with `flatpak run --user buzz.armada.app` and close it
again before the uninstall. This brief overlap leaves the known-working system
deployment in place if downloading or installing the bundle fails.

Do not add `--delete-data` to the uninstall: leaving it out preserves the
profile under `~/.var/app/buzz.armada.app`. If the now-unused unsigned system
remote remains listed, remove only that captured origin:

```sh
sudo flatpak remote-delete --system "$armada_system_origin"
```

After the first signed release and its public key are both live, existing
bundle installs need a one-time trust migration. Verify
`armada-flatpak.gpg` against the fingerprint the nsite manifest attests, as
shown above, then upgrade the app's actual origin in place:

```sh
armada_origin="$(flatpak info --user --show-origin buzz.armada.app)"
flatpak remote-modify --user --enable --gpg-verify \
  --gpg-import=./armada-flatpak.gpg \
  --url=https://armada.buzz/downloads/flatpak/ "$armada_origin"
flatpak update --user buzz.armada.app
```

For an installation deliberately kept system-wide, perform the same migration
in the system installation:

```sh
armada_origin="$(flatpak info --system --show-origin buzz.armada.app)"
sudo flatpak remote-modify --system --enable --gpg-verify \
  --gpg-import=./armada-flatpak.gpg \
  --url=https://armada.buzz/downloads/flatpak/ "$armada_origin"
sudo flatpak update --system buzz.armada.app
```

Never perform either trust flip before the signed release is available. New
signed bundles already embed the key and enable GPG verification, so they do
not need this one-time procedure. The migration is opt-in: an existing
`no-gpg-verify` origin ignores the signatures the repository now carries and
keeps updating unchanged, so signing breaks no current installation.

For a local package-manager update cycle:

```sh
flatpak remote-add --user --no-gpg-verify armada-local \
  "file://$PWD/release/flatpak-repo"
flatpak install --user armada-local buzz.armada.app
flatpak update --user buzz.armada.app
```

Release bundles embed `https://armada.buzz/downloads/flatpak/` as the app's
origin, and signed bundles additionally embed `armada-flatpak.gpg`, which makes
that automatically configured origin GPG-verified. **CI no longer publishes
that OSTree repository** — nothing in `release.yml` deploys over SSH any more.
The repository left there by earlier releases is whatever is still served;
updating it is a manual step (`electron/release/flatpak-repo/` is what a tagged
build produces, after the `publish` job has signed and verified it).

Installs made from an older bundle with a blank origin or the legacy
`https://armada.buzz/flatpak/` origin must use the one-time trust migration
above or remove the old app (without `--delete-data`) before installing a
corrected bundle; installing over the existing deployment can retain its prior
origin.

Production release signing is provisioned with
`FLATPAK_GPG_PRIVATE_KEY_BASE64`, a base64-encoded export of exactly one
long-lived Flatpak signing key, and
`FLATPAK_GPG_EXPECTED_FINGERPRINT`, that key's full primary fingerprint. CI
normalizes the expected value to uppercase without whitespace, imports the key
into a temporary GnuPG home, derives exactly one full primary fingerprint, and
requires an exact match before signing. The secret key must be usable by CI
without an interactive passphrase; a noninteractive signing probe checks that
before the release proceeds.

The package build and signing are deliberately separate. `flatpak/build.sh`
runs without credentials and rejects `FLATPAK_GPG_KEY` or
`FLATPAK_GPG_PUBLIC_KEY`. CI then starts a fresh dependent container, verifies
the committed `flatpak/sign.sh` against the digest pinned in the already-loaded
workflow, and only then imports the release key. That signer signs the app,
AppStream commits, and repository summary, then replaces the bundle with one
carrying the public key. CI publishes that
binary OpenPGP public-key export as
`/downloads/flatpak/armada-flatpak.gpg` alongside
`armada-flatpak.fingerprint`. A deployable release fails closed when the secret
or expected fingerprint is absent, when the export does not contain exactly
one primary key, or when the fingerprints differ. The same public-key file is
passed to `flatpak build-bundle --gpg-keys`; signing the repository alone would
not enable verification for a bundle's automatically configured origin.
The announcement is not prose an operator has to remember to write. The full
fingerprint is COMMITTED at `public/.well-known/armada-flatpak.fingerprint`,
ships in the static build like `assetlinks.json`, and is therefore named by
sha256 in the nsite manifest `deploy-nsite.yml` signs — so the channel that
vouches for the key is a Nostr key rather than the same web server that serves
it. Two gates keep the two halves in step: the signing step compares that
committed file, read out of the object database, against the fingerprint of
the key it actually imported and fails the tag if they differ; and the nsite
deploy refuses to publish a manifest whose copy is missing, malformed, or not
byte-identical to the committed one. A rotation is therefore one commit plus
one secret change, and forgetting either half fails a release rather than
shipping a key nothing independent names.

Changing the expected-fingerprint secret is an explicit key rotation, not
routine release maintenance: once installs verify against a key, a lost or
expired one stops their updates with no in-band recovery, and every affected
user has to import the replacement by hand. Create the signing key without an
expiry date.

The manifest swaps only venmic's native prebuild to its
Freedesktop-25.08-compatible 6.1 build; AppImage and deb retain the
lockfile-pinned 7.x build.

## CI

`.ngit/act/workflows/release.yml`, on version tags (`vX.Y.Z`) — the `desktop`
job builds the web bundle and desktop DB bridge, then every published platform
from a single Linux container.

Nothing is served over HTTP by CI any more, and nothing is deployed over SSH.
Every installer — including the signed `.flatpak` bundle — is staged into
`.release-artifacts/`, uploaded to Blossom, and named by hash in the kind-30622
release event the `release` job publishes (`docs/releases.md`), which is what
`/downloads` reads and what the desktop app self-updates from.

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
  Developer ID–signed electron-builder release omits that marker and self-updates
  from the per-arch zip in the release event. This is the one platform the switch
  to the event newly enabled rather than merely moved: `latest-mac.yml` was never
  among the files CI deployed, so the static feed had nothing for macOS at all,
  while the `-mac-x64.zip` / `-mac-arm64.zip` artifacts have been in the event
  since it existed.
- **`.zip`, not `.dmg`.** A disk image needs HFS+ tooling that isn't in the
  container (Firefox cross-builds `.dmg` on Linux with `libdmg-hfsplus`, if
  that's ever wanted). Zip is a first-class macOS distribution format — it's
  what Electron's own auto-updater consumes — and an unsigned `.dmg` would buy
  nothing but the drag-to-Applications ritual.

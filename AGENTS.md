# AGENTS.md

Guidance for agents working on the **Armada client** — the web app (repo root),
the Capacitor Android project (`android/`), the Capacitor iOS project (`ios/`),
and the Electron desktop shell (`electron/`).

Armada's focus is [Concord](https://github.com/concord-protocol/concord):
serverless, end-to-end encrypted communities that need no host.

**Concord is the default subject.** An unqualified request — "rooms",
"channels", "invites", "the member list", "voice" — is about Concord. The
client also still supports NIP-29 relay-based "servers" for operators who
self-host, including [Buzz](https://github.com/block/buzz) relays (a
NIP-29-based team-communication relay with custom kinds, rendered through the
shared NIP-29 pages, `src/buzz/`) — but assume that side only when NIP-29,
Buzz, or a relay-hosted server is named explicitly. When a change could
plausibly land on either, ask rather than guessing NIP-29.

**"Concord" means the protocol at the link above**, its first public release
(CORD-01..07). There is no "v2" — it is simply the Concord Protocol. (A legacy,
incompatible predecessor shipped in Vector and Armada; Armada removed it, and
nothing here implements it.) The `c2:` and `concord2-*` spellings that survive
in the code are ON-DISK identifiers — ArmadaDB tenant ids, KV/localStorage
keys, the Android `concord2Subs` pref, and the cross-client `concord2|` app
scope key — deliberately left at their old spelling so existing installs keep
their data. Don't "finish" the rename.

The optional self-hostable backend (NIP-29 relay + LiveKit voice + Concord AV
broker) and all deployment/hosting docs live in the separate
[`armada-relay`](https://gitlab.com/soapbox-pub/armada-relay) repository — this
client does not depend on it at build time.

## Repo layout

| Path         | What                                                            |
|--------------|-----------------------------------------------------------------|
| `src/`       | React 19 + Vite web client (Tailwind + shadcn/ui + Nostrify)    |
| `src/concord/` | The Concord protocol implementation (CORD-01..07): stream, control, chat, invites, rekey, voice, crypto derivations |
| `src/lib/db/` | ArmadaDB — the one local storage interface (tenants of rumors + a KV), its IndexedDB adapter, the Android bridge adapter, and the migrations |
| `android/`   | Capacitor Android project (signed APK/AAB built in CI)          |
| `android/…/app/db/` | ArmadaDB in Kotlin: the SQLite engine the Android build actually runs, shared by the WebView and the notification service |
| `ios/`       | Capacitor iOS project (SwiftPM, no CocoaPods; built manually on a Mac — no CI) |
| `ios/ArmadaDB/` | ArmadaDB in Swift: the SQLite engine the iOS build runs, with SQLite vendored. A SwiftPM package so it builds on **Linux**, where its conformance suite runs without a Mac |
| `electron/`  | Electron desktop shell (loads the bundled web build; Linux/Windows/macOS installers built in CI) |
| `Dockerfile` + `nginx.conf` | nginx-served static build for web hosting        |

## Build / test

`npm install && npm run test` — tsc + eslint + vitest + production build. Always
run this before committing changes.

`npm run dev` serves at http://localhost:8080.

## CI: ngit-ci (primary) and GitLab (mirror)

The repository is a Nostr Git repo; CI runs on **ngit-ci** — a self-hosted,
Nostr-native coordinator that watches the repo announcement and executes
workflows in `.ngit/act/workflows/` with [`act`](https://github.com/nektos/act)
(GitHub Actions-compatible syntax, one Linux container per job). Results and
build artifacts are published to Nostr and shown on gitworkshop.dev against the
commit/PR.

| Workflow | Trigger | What |
|----------|---------|------|
| `test.yml` | push (any branch) + PR | `npm run test` (tsc + eslint + vitest + build), the Swift ArmadaDB conformance suite (`swift test --package-path ios/ArmadaDB`), and `npm audit --audit-level=high` |
| `deploy-web.yml` | push to `main` | build + rsync-over-SSH deploy of the hosted client (armada.buzz); skips deploy if the SSH secret isn't provisioned |
| `release.yml` | tag `v*` | signed Android APK + AAB, published as run artifacts and the APK to `armada.buzz/downloads/`, then Zapstore publish, then Google Play publish (draft release while the app is unpublished in Play Console; skips Play if the service-account secret isn't provisioned) |
| `desktop.yml` | tag `v*` | Electron Linux (AppImage + deb), Windows (NSIS + portable) and macOS (ad-hoc signed .app zips, cross-built); published as run artifacts and rsynced to `armada.buzz/downloads/` |

Notes specific to ngit-ci (vs the old GitLab pipeline):

- **No pipeline counter.** Android `versionCode` is derived from the semver tag
  as `major*1_000_000 + minor*1_000 + patch` (e.g. `v0.31.1` → `31001`).
  GitLab used `$CI_PIPELINE_IID` (last GitLab release v0.30.1 was code 402); the
  first ngit-ci releases used `10000 + git rev-list --count HEAD`, but ngit-ci's
  runner shallow-fetches only the tagged commit so the count was always 1 —
  every release got the same code and Zapstore silently dropped duplicates. The
  tag-derived scheme is deterministic, monotonic with semver, and independent of
  checkout depth. `versionName` is still the tag minus `v`.
- **Secrets are operator-provisioned and maintainer-gated.** `${{ secrets.* }}`
  is populated only for secrets the ngit-ci operator has provisioned for this
  repo's `#ALIAS`, and only on maintainer-authored triggers (a maintainer's
  push, or a maintainer's PR). Third-party PRs run with empty secrets. There is
  no `GITHUB_TOKEN`. Required secrets: `ANDROID_KEYSTORE_BASE64`,
  `KEYSTORE_PASSWORD`, `KEY_PASSWORD`, `ZAPSTORE_BUNKER_URL`,
  `ZAPSTORE_CLIENT_KEY`, and for web deploy `DEPLOY_SSH_KEY_BASE64`
  (+ optional `DEPLOY_SSH_CONFIG_BASE64`, `DEPLOY_TARGET`).
  Optional: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (base64 of the Play Console
  service-account JSON for `buzz.armada.app`; unprovisioned skips the Play
  publish); `KLIPY_API_KEY` (switches GIF search from the keyless GIFverse
  default to KLIPY; unprovisioned keeps GIFverse).
- **No macOS runner, which is not the same as no macOS build.** act runs Linux
  containers only, and ngit-ci leaves a workflow unclaimed if its `runs-on`
  label isn't one the coordinator serves — so nothing here ever executes on a
  Mac. The desktop app is shipped for macOS anyway, cross-built:
  `electron/scripts/package-mac.mjs` assembles the `.app` from the prebuilt
  darwin Electron plus the asar electron-builder already staged, and
  `rcodesign` ad-hoc signs it so an arm64 Mac will exec it at all. What genuinely
  needs Apple is a Developer ID signature + notarization (so a first launch
  still needs the user's Open Anyway), and `.dmg` packaging — hence `.zip`.
  Reach for this shape before assuming a target is out of reach: the blocker is
  usually Apple's *signing* tooling, not the bundle format.
- **act images are minimal.** They are not full GitHub-hosted runners: use setup
  actions (`actions/setup-node`, `setup-java`, `android-actions/setup-android`)
  and install anything else explicitly (e.g. `rsync`, `wine`).
- **`ubuntu-latest` runs in a pre-baked `armada-ci` image.** The coordinator
  maps the label to it via `NGIT_CI_ACT_PLATFORMS`; the Dockerfile lives in
  `.ngit/ci-image/` and pre-installs the JDK/node toolcaches (setup-* actions
  no-op),   the Android SDK, system ruby+fastlane, the zsp binary, wine, the Swift
  toolchain (for `ios/ArmadaDB`'s suite), and
  warm `~/.gradle` (incl. build cache) / `~/.npm` /
  `~/.cache/electron{,-builder}` caches for this repo. Cold runs on the stock
  act image re-downloaded ~700 MB of toolchain+deps and blew the coordinator's
  30-min default job timeout (`NGIT_CI_JOB_TIMEOUT_SECS`, raised to 3600
  server-side). Rebuild with `.ngit/ci-image/build.sh` on the coordinator host
  when `package-lock.json`, `electron/package-lock.json`, the android/gradle
  deps, or the Swift pin change; the setup-* actions self-heal version drift in
  between — but there is NO setup-swift step, so `swift test` fails outright on
  an image that predates it.
- **act mounts the persistent `act-toolcache` volume over
  `/opt/hostedtoolcache`** in every job container, seeded from the image only
  while empty. Toolcache content added by an image rebuild is invisible to
  jobs until the volume is removed (`build.sh` does this) — and anything a
  workflow invokes directly must live OUTSIDE `/opt/hostedtoolcache` (this is
  how `fastlane: command not found` broke two releases; fastlane is now the
  system-ruby gem with binstubs in `/usr/local/bin`).
- **Workflow runs are parallel; jobs within one workflow are not.** The
  coordinator runs up to `NGIT_CI_MAX_CONCURRENT_JOBS` (currently 2) workflow
  runs at once, each in its own `/data/work/<run_id>/repo` checkout — but all
  jobs of ONE workflow share that single bind-mounted checkout, so
  multi-job workflows race on the working tree (why desktop.yml is one job
  building all three platforms). Job containers are capped by
  `NGIT_CI_ACT_CONTAINER_OPTIONS` (currently `--cpus=8 --memory=10g`).

## The `/downloads` page and what CI publishes under it

`src/pages/DownloadsPage.tsx` links **stable, unversioned filenames**
(`Armada.AppImage`, `Armada-Setup.exe`, `Armada.apk`, …) that `desktop.yml` and
`release.yml` re-copy beside the versioned archive on every tag. That split is
the point: the page is a compile-time constant with no version to discover, and
old releases still keep their own `Armada-vX.Y.Z.*` URLs. `src/lib/downloads.ts`
is the one table of those names, and its test READS THE TWO WORKFLOW FILES and
asserts every filename and manifest key it links is published by one of them —
so renaming a file in CI without the client fails the suite rather than 404ing
in production on the next tag.

**armada.buzz is served by Caddy, not by this repo's `nginx.conf`.** The hosted
config lives on the venus VPS at `/etc/caddy/sites-available/armada.buzz` and is
not in version control; `nginx.conf` covers only the Dockerfile self-host path,
where the rules differ enough to be worth stating separately. Traps:

- **A missing installer must 404, and by default it does not.** Caddy's
  catch-all ends in `try_files {path} /index.html`, so a pruned, misspelled or
  not-yet-published file under `/downloads/` answered **200 with the 12 KB SPA
  shell** — a browser saving `Armada.AppImage` that is HTML. The site config
  now has a `handle /downloads/*` with a bare `file_server` ahead of the
  catch-all so those paths 404 properly. `handle` blocks are mutually
  exclusive, which is the sharp edge: the catch-all's `Cache-Control: no-cache`
  does NOT reach inside, and had to be restated there or the SPA shell at
  `downloads/index.html` would be heuristically cached, pinning chunk hashes a
  later deploy no longer has. Versioned archives get `immutable` instead, being
  content-addressed by filename.
- **The directory does NOT shadow the route on Caddy, but it does on nginx.**
  Caddy's `try_files` skips directories, so `/downloads` renders the SPA either
  way. nginx's `try_files $uri $uri/ /index.html` matches `$uri/` against the
  real directory and stops — with no index and autoindex off, a **403** on
  reload or a shared link. `deploy-web.yml` uploads `dist/index.html` as
  `downloads/index.html`, which fixes nginx and also gives Caddy's
  `handle /downloads/*` something to serve for a bare `/downloads/`.
- **`.AppImage` content type differs by server.** Caddy knows it
  (`application/vnd.appimage`); nginx's `mime.types` does not, so it inherits
  `default_type` — `text/plain` by default, i.e. a browser rendering a 100 MB
  binary as text. `nginx.conf`'s `location /downloads/` sets
  `application/octet-stream`, and the page's anchors carry `download` as the
  same-origin belt-and-braces.
- **Each workflow writes its OWN manifest** (`latest-desktop.json`,
  `latest-android.json`). Both fire on the same tag and run concurrently, so one
  shared `latest.json` would be a lost update — and worse, whichever wrote last
  would claim its version for a platform whose build had failed. The manifests
  carry only a version label and file sizes; the page treats them as decoration
  so a failed fetch never costs a working button.

The rsyncs are additive (**no `--delete`**, on any of the three workflows) —
that is what lets installers, the page's index, and the site build coexist in
one jail root. Don't add one without excluding `/downloads`.

## How the client reaches backends (no build-time coupling)

The client talks to relays and voice brokers over **runtime-configurable URLs**,
never a compiled-in server address:

- Relay/server traffic is Nostr over WebSocket to user-added / configured relays.
- The relay's HTTP endpoints (NIP-29 LiveKit token, push) are derived at runtime
  from the relay's WS URL via `relayToHttpUrl()` in `src/lib/platform.ts`.
- Concord voice (CORD-07) fetches LiveKit tokens from a blind AV broker,
  defaulting to `VITE_CONCORD_AV_SERVERS` (public `https://armada.buzz`).

There is **no build-time relay pin at all** — every build, hosted included, has
no baked-in servers, and the user adds their own. Don't reintroduce one: a pin
is a WebSocket the client dials on boot whether or not that origin speaks Nostr
(the hosted `wss://armada.buzz` pin dialed the SPA's own origin, which serves
HTML and never upgrades), and `ws://localhost` is meaningless on a phone.

## Voice / LiveKit (client side)

The LiveKit JS SDK **always appends `/rtc`** to the server URL it's given, so a
voice server URL must be the bare origin (e.g. `wss://armada.example.com`), never
`.../rtc`. When bumping `livekit-client` in `package.json`, the self-hostable
LiveKit **server image** must be bumped to a matching/newer release in
`armada-relay` (signaling protocol skew makes clients full-reconnect every
~16s). Full voice/LiveKit hosting guidance lives in `armada-relay`'s `AGENTS.md`.

## Android App Links (deep linking)

The Android app registers a verified `https` intent filter for **armada.buzz**
(`android/app/src/main/AndroidManifest.xml`), so invite/share links open in the
app. Verification requires `https://armada.buzz/.well-known/assetlinks.json` to
be served by the web client (the file lives in `public/.well-known/` and ships in
the static build). It lists the APK signing cert's SHA-256 fingerprint (get it
with `apksigner verify --print-certs Armada.apk`). If the signing key rotates, or
the app is published through a store that re-signs (e.g. Play App Signing), add
the new cert fingerprint to the array.

## iOS (Capacitor)

`ios/` is a Capacitor 8 iOS project. Capacitor 8 wires plugins through
**SwiftPM** (`ios/App/CapApp-SPM/Package.swift`, regenerated by `cap sync`), so
there is **no CocoaPods** — a Mac with Xcode and Node is the whole toolchain.
`Package.resolved` is committed to pin `capacitor-swift-pm` and transitive
plugin deps.

Build (on a Mac; there is no iOS CI — act runs Linux containers only, same
reason the macOS `.dmg` stays on the GitLab mirror):

```sh
npm ci && npm run build && npx cap sync ios
cd ios/App && xcodebuild -project App.xcodeproj -scheme App \
  -sdk iphonesimulator -configuration Debug \
  -destination 'generic/platform=iOS Simulator' build
```

For a release build use `scripts/ios-release.sh [vX.Y.Z]` (`ARCHIVE=1` to
archive for distribution). The version is carried by the git tag like every
other target — nothing is committed — and it stamps `MARKETING_VERSION` from
the tag plus `CURRENT_PROJECT_VERSION` from the SAME
`major*1_000_000 + minor*1_000 + patch` scheme Android's `versionCode` uses.
Monotonicity is load-bearing: App Store Connect rejects an upload whose build
number doesn't exceed the previous one.

- **Don't pass `CODE_SIGNING_ALLOWED=NO`** even for the simulator. An unsigned
  app has no keychain-access-group entitlement, so every
  `capacitor-secure-storage-plugin` write fails (`errSecMissingEntitlement`,
  surfacing as a bare `"error"`) — which is where the nsec lives. Xcode's
  default ad-hoc simulator signing is enough.
- Signing is automatic against `DEVELOPMENT_TEAM = GZLTTH5DLM` (Soapbox
  Technology LLC), set in `project.pbxproj`. The Team ID is also baked into the
  `appIDs` of `public/.well-known/apple-app-site-association`, so a team change
  means changing both or universal links silently stop associating.
- **Storage is ArmadaDB in Swift, in an App Group container.** `ios/ArmadaDB`
  is the engine; `ArmadaDbPlugin.swift` is the transport, registered from
  `ViewController.capacitorDidLoad()` rather than through
  `capacitor.config.json`'s `packageClassList`, which `cap sync` regenerates
  from npm packages and would drop an app-local plugin from. The file lives in
  `group.buzz.armada.app`, NOT the app sandbox, because that is the only
  container a notification extension can also open — and the choice stops being
  reversible the moment a build ships, since moving it later strands decrypted
  Concord and NIP-17 history that exists nowhere else. `ArmadaDbLocation`
  refuses to fall back to the sandbox for the same reason. The App Group must
  be enabled on the App ID in the developer portal, like Associated Domains.
- The WebView origin is `capacitor://localhost` (Android uses
  `https://localhost`). Changing `server.iosScheme` later would move the
  origin and orphan any OPFS/localStorage data, so treat it as
  fixed. (ArmadaDB itself is no longer at risk — it is a file in the App Group
  container, not storage keyed by the origin.) `shareOrigin()` already returns
  the public web origin on native.
- Safe-area insets are native on iOS (the safe-area plugin is an Android
  edge-to-edge polyfill), driven by `viewport-fit=cover` in `index.html`.
  `contentInset: 'never'` keeps UIKit from adding a second inset on top of the
  app's `env(safe-area-inset-*)` padding.
- `Info.plist` carries `NSCameraUsageDescription` /
  `NSMicrophoneUsageDescription` for LiveKit calls, voice messages and the
  WebView file input's "Take Photo or Video". Add a usage string *before*
  reaching for a capability — iOS kills the process on first use otherwise.
- Icon/splash are generated from `public/logo.svg` into
  `ios/App/App/Assets.xcassets` (app icon = the blade mark on `#100b15`, no
  alpha, matching the Android launcher icon; launch screen = the crest on the
  same background).
- **`PrivacyInfo.xcprivacy` has to be in the Resources build phase, not merely
  in the folder.** It is wired into `project.pbxproj` by hand (file reference +
  `PBXBuildFile` + the `App` group + `PBXResourcesBuildPhase`); a manifest that
  is only on disk ships in no bundle and App Store Connect still rejects the
  upload with `ITMS-91053`. Nothing generates it — `cap sync` doesn't, and none
  of the Capacitor SPM plugins vendor one of their own, so the app target's
  manifest is the only one in the binary and must cover their APIs too. What it
  declares: file-timestamp (`C617.1`), disk-space (`E174.1`) and user-defaults
  (`CA92.1`) reasons, all reached through the **vendored SQLite**
  (`ios/ArmadaDB/Sources/CArmadaSQLite`, which calls `stat`/`fstat`/`lstat` and
  `statfs`/`fstatfs`) rather than through any Swift written here —
  `ArmadaDbPlugin.swift` touches no required-reason API at all. Tracking is
  `false` and there are no tracking domains. Re-check the required-reason list
  when the SQLite amalgamation is re-pinned or a plugin is added.
- **Export compliance is the PUBLISHED SOURCE route, and it is not the one the
  file used to claim.** The binary carries non-OS crypto — ChaCha20 with
  HMAC-SHA256 (NIP-44 v2; *not* ChaCha20-Poly1305), HKDF-SHA256 and secp256k1,
  all bundled from `@noble/*` — so `ITSAppUsesNonExemptEncryption` is `true` and
  no "OS crypto only" exemption applies. (The AES-256-GCM on Concord
  attachments is the OS's, via WebCrypto; don't list it as bundled.) But
  Armada's source is publicly available, which puts the corresponding object
  code outside the EAR under 15 CFR 734.3(b)(3) on the strength of a
  **one-time** 742.15(b) notification of the source URL to BIS and NSA ENC — no
  ERN, and none of the annual February 1 self-classification reporting the
  5D992.c / 740.17(b)(1) route would have obliged forever. Two standing duties
  follow, and both are easy to lose: the source must STAY published, and a move
  of the canonical repo URL means re-notifying. Don't "simplify" the comment at
  `ios/App/App/Info.plist` back to self-classification.

Android-only pieces that are simply absent on iOS, and are gated so they don't
surface dead UI or throw: the `ArmadaNotification` background relay service
(use `hasNativeNotificationService()`, not `isNativeRuntime()`, for anything
touching it), NIP-55 external signers (Amber), the Bluetooth mesh, and
the Credential Manager nsec export (itself Android 14+ only — see Conventions).
**iOS therefore has no notifications at
all** — no background service, and no Web Push in WKWebView; that needs APNs or
a native iOS equivalent.

Deep links: armada.buzz **universal links work**, via the
`com.apple.developer.associated-domains` entitlement in
`ios/App/App/App.entitlements` plus
`public/.well-known/apple-app-site-association` (shipped in the static build
like `assetlinks.json`, and matching every path on the host exactly as the
Android intent filter does). No app code is involved: `AppDelegate` already
proxies `continue userActivity` to Capacitor, and `deepLinkUrl.ts` /
`coldLaunchDeepLink.ts` are platform-agnostic. Two things this can break on —
the AASA must be served with `Content-Type: application/json` and **no
redirect** (it is extensionless, so nginx needs the explicit `location =`
block in `nginx.conf`), and its `appIDs` must be `<TEAMID>.buzz.armada.app`.
There is still no `CFBundleURLTypes` entry, so the `armada://open<path>` scheme
does not resolve — deliberately: per `deepLinkUrl.ts` that scheme is emitted
ONLY by the Android notification service's PendingIntents, so on iOS nothing
can currently produce one. Add it with the notifications work, not before.

## Local storage: ArmadaDB

One interface (`src/lib/db/types.ts`) — tenants of rumors plus a KV — with a
different engine per platform:

| Platform | Engine |
|----------|--------|
| Web | `IndexedDBArmadaDB` (Nostrify's `NIndexedDB` per tenant) |
| **Android** | `NativeArmadaDB` → `ArmadaDbPlugin` → **Kotlin** (`android/…/app/db/`) |
| **iOS** | `NativeArmadaDB` → `ArmadaDbPlugin` → **Swift** (`ios/ArmadaDB/`) |
| **Desktop** | `NativeArmadaDB` → Electron IPC → `SqliteArmadaDB` on `node:sqlite`, in the main process (`electronMain.ts`, `nodeSqlDriver.ts`) |

All three native rows are the SAME JS adapter with a different transport under
it, so the write coalescing, the KV `kvOps` batching and the read-your-writes
ordering are written once. A new platform adds a bridge, not an adapter — though
one whose background writer needs the query engine in-process (Android's
service, iOS's future notification extension) does add an engine port below the
bridge.

On Android the query engine is native and there is exactly one database file.
The background notification service writes an event into the same tenant the
WebView reads it from, so a message received while the app was dead is simply
*there* on open. `drainEvents`/`ackDrain` still exist but are ROUTING only — a
pass through wire ingest (parking wraps, ringing scopes, notification
candidates) — over the `svc:<relay>` queue tenants, not the path by which
anything becomes durable.

Things to know before touching it:

- **Scope by what the data IS, and for NIP-29 that includes its relay.** A group
  is named by an `h`/`d` value that means nothing on its own: the same id on two
  relays is two unrelated groups, and relay software that ships a SHARED signing
  identity (zooid) defeats scoping by author too — with kind 39000 addressable,
  two servers' metadata then *replace* one another rather than merely mix. So
  NIP-29 lives in `nip29:<normalized relay url>`, one tenant per relay, and the
  isolation is structural rather than a side-table of provenance that a read has
  to remember to consult. `relayScope.ts` (+ `RelayScope.kt`) is the only place
  the rule lives: an `h` tag or a relay-signed 39000-39005/13534 is relay-scoped,
  everything else is `main`. Corollary: an event whose source relay is unknown (a
  pool-wide `.query()`, a `group(urls)` read) is NOT stored rather than filed
  under a guess — every NIP-29 read path uses `nostr.relay(url)` and knows its
  relay, and a dropped cache row is refetchable from the one relay that has it.
  Don't relay-scope global data (profiles, the user's own lists, git): that forks
  one identity into a copy per relay.
- **The Kotlin and Swift ports must stay in step with `SqliteArmadaDB.ts`.**
  Same schema, same `seq = created_at × 2²⁰ + n` rowid encoding, same tag-token
  escaping, same planner. `ArmadaDbTest.kt` and `ArmadaDbTests.swift` are the TS
  conformance suite ported over; run them (`cd android && ./gradlew
  :app:testDebugUnitTest`, `cd ios/ArmadaDB && swift test`) for any change to
  any of the three. The Swift suite needs no Mac — that is why the engine is a
  SwiftPM package rather than files in the app target.
  Where Swift needed more than transcription, and why: string ORDER is UTF-16
  code units (Swift's `<` compares by canonical equivalence, so a decomposed
  accent equals a composed one, and UTF-8 bytes sort astral characters on the
  wrong side of U+E000..U+FFFF) — the `id ASC` tie-break and the KV range bounds
  are contract, not detail; text binds with an explicit BYTE COUNT, since
  SQLite reads a length of `-1` as "up to the first NUL" and would truncate any
  user-controlled string containing one; and a KV prefix upper bound that lands
  on an unpaired surrogate is reported as NO bound, because Swift strings can't
  hold one — the scan widens and the range check does the filtering.
- **SQLite is bundled, not borrowed.** The schema needs FTS5 with
  `contentless_delete` (3.43+) and JSON1; Android's platform SQLite is 3.9 on
  minSdk 24 and has neither. `androidx.sqlite:sqlite-bundled` ships 3.50.1 per
  ABI (~1.2 MB each, ~5 MB on a universal APK) and the same build for the JVM,
  which is what lets the conformance suite run the real engine as a plain unit
  test. iOS vendors the amalgamation (`ios/ArmadaDB/Sources/CArmadaSQLite`,
  compiled with `SQLITE_ENABLE_FTS5`) pinned to the SAME 3.50.1, so the two
  native platforms run one SQLite rather than two that merely both pass; Apple's
  `libsqlite3.dylib` only reaches 3.43 around iOS 17, two releases past the 15.0
  deployment target. Desktop gets its engine from Electron's embedded Node (`node:sqlite`),
  which is why the Electron major is a storage dependency, not just a Chromium
  one: `node:sqlite` landed in Node 22.5, so Electron 33 (Node 20) could not
  host the store at all. Electron 43 is Node 24 / SQLite 3.53. Check both when
  bumping, and don't drop below a major that has it.
- **The desktop store is the same TypeScript engine the tests run.**
  `src/lib/db/electronMain.ts` is bundled to `electron/db.cjs`
  (`vite.config.electron.ts`, `npm run build:electron-db`) and `require`d by
  `main.js`, so there is no hand-written JS copy of the store to drift. Two
  consequences: the bundle is a BUILD ARTIFACT (gitignored, and `desktop.yml`
  must build it — a missing `db.cjs` is not a build failure, it is a shipped app
  quietly storing data in the wrong place), and it must stay free of Electron
  imports so `tsc`/eslint cover it as ordinary `src/` code. The file lives at
  `app.getPath("userData")/armada.db`, and `preload.js` answers
  `armada:db-available` SYNCHRONOUSLY because the renderer picks its adapter
  before anything reads.
- **The adapter is chosen before anything reads.** The legacy drains in
  `migrations.ts` write through `getArmadaDB()`, so on Android and desktop they
  land in the native store directly — there is no IndexedDB ArmadaDB to move
  (the desktop shell had no released build storing data), and adding a
  second hop would be a second chance to strand decrypted Concord and NIP-17
  history that exists nowhere else.
- **The service is a second writer, so it obeys the same store rules.** `Dm17.kt`
  ports NIP-17's kind filter and NIP-40 expiry refusal;
  `ServiceStore.storeConcord2Rumor` ports the chat plane's encrypted-seal rule;
  `RelayScope.kt` ports the tenant routing; `SelfState.kt` ports the self-sync
  catalogue (`selfSyncKinds.ts`) so the service can mirror the user's own
  replaceable documents — follow/mute lists, the 10009 server list, the Concord
  vaults, the NIP-78 settings document holding the rail's arrangement — into
  `main` while the app is dead, which is what makes a change made on another
  device already be on disk at open instead of racing a cold relay read. A rule
  only one writer applies is a
  conversation the two disagree about — for routing, literally a message stored
  where the timeline never reads — and the rules are load-bearing precisely
  because nothing is stored beside the rumor for a reader to re-check them
  against. Relay-URL normalization stays JS-side (the service is configured with
  already-normalized URLs) so there is one spelling of a tenant id, not two.
- **Never inject a tag into a stored rumor, and don't store a row beside it
  either.** Its tags are the bytes its id commits to, so bookkeeping written
  into them makes the row something the sender never signed, and makes whatever
  reads that tag forgeable by anyone who spells it. Derive instead: a DM's
  partner comes from `pubkey` and the `p` tags NIP-17 requires (`dmPeerOf`), and
  a thread is two ordinary indexed filters — `authors: [peer]` and
  `authors: [self], "#p": [peer]`. A Concord plane is its KINDS
  (`PLANE_RULES`/`queryPlane`), and a rekey round names its own scope and epoch
  in the tags `parseRekey` reads — so neither the stream address, the carrier
  wrap id nor the seal kind is stored at all. They are checked ONCE, at ingest
  (`writeOpened`), against the stream keys that actually opened the wrap, and
  wherever the seal form is still known in memory (`parseEdition` and friends —
  freshly-swept events reach a fold without a store round-trip).
- **The one exception is worth knowing, because it is the shape of a real
  one.** A compaction re-wraps control editions VERBATIM under the new epoch's
  address (CORD-06 §3), so whether an edition is in the current snapshot is
  genuinely not in the rumor. It lives in KV as a set of rumor ids per control
  stream address (`c2snap:<community>:<pk>`, `readControlSnapshot`) — the fact
  itself, not an event-shaped row impersonating one.
- **A drain converts to the CURRENT shape; it does not copy rows across.** The
  pre-ArmadaDB store folded `stream`/`wrap`/`sealkind`/`seal` into the stored
  event's tags and told the planes apart by the `stream` tag at read time, so
  it enforced no kind or seal-form rule at write. Planes read back by kind now,
  and that is sound only because `writeOpened` refuses, at ingest, a rumor whose
  kind does not belong to the plane whose keys opened its wrap — so
  `rumorMigration.ts` applies those same three refusals to every row it copies,
  using the `stream` tag it is about to strip as proof of the arrival plane.
  Copying verbatim would mint a control edition out of any guestbook
  keyholder's rumor.
- **The localStorage→KV move happens in the gate, and nowhere else.**
  `LOCALSTORAGE_MOVES` in `db/schema.ts` is the only place the old key
  spellings are written down; `KvPrefixCache` knows nothing about localStorage
  and reads KV only. Don't put a "check localStorage on miss" fallback in a
  cache or a hook — that is the drift the single table exists to prevent, and
  it would re-run on every warm forever.
- The bridge carries JSON **text**, not marshalled objects: Capacitor would
  have to guess between an integer `kind` and a float, and a page of rumors is
  far cheaper as one string.

## Conventions

- **Never publish a user's Nostr lists without an explicit user action.** This
  covers every user-owned replaceable/list event: kind 10050 DM relays, kind
  10009 servers/groups, follow/mute lists, NIP-65, Concord membership lists.
  No publish-on-mount, publish-on-visit, publish-on-sync, or "publish a
  default because the read came back empty" — an empty read is
  indistinguishable from a failed one (cold pool, AUTH, wrong relay set), and
  replaceable events make such a publish destroy the user's real list
  everywhere. List writes must be read-modify-write and must refuse to build
  on an empty/failed read when local persisted state says a non-empty list
  existed. Preserve the existing event's format: a list stored as public tags
  (e.g. by Flotilla) stays public; encrypted private items stay encrypted.
  This rule has been violated twice with user-visible data loss — do not
  reintroduce any automatic list publish, however well-intentioned. The ONE
  sanctioned exception is signup: when the account wizard generates a key
  ITSELF, it publishes a default kind-10002 for that key
  (`handleContinue` in `WelcomePage.tsx`). This is safe precisely because the
  rule's hazard cannot arise — a key minted moments ago has provably never
  published a list, so there is no existing/failed-read list to clobber. It is
  scoped structurally to the generate path (existing-key logins never reach it)
  and is the only place an unsolicited list publish is allowed.
- **No Google Play Services in the Android build.** The APK ships zero
  `com.google.android.gms` / `googleid` artifacts, and the merged manifest has
  zero Google components — verify with
  `grep -icE "gms|googleid" android/app/build/intermediates/merged_manifests/debug/*/AndroidManifest.xml`
  after any dependency change. The trap is that one innocuous-looking AndroidX
  line pulls the whole subtree: `androidx.credentials:credentials-play-services-auth`
  alone brought in eight proprietary artifacts, which is why it was removed and
  why Credential Manager is Android 14+ only here (the platform service exists
  from API 34; below that androidx.credentials has no provider, and Google's is
  the only one that ships). Older devices fall back to the key-file export, which
  `backUpNsec` already does — don't "fix" them by re-adding the dependency.
  Likewise `com.google.gms:google-services` is off the buildscript classpath:
  notifications are an okhttp WebSocket to the user's relays, never FCM.
  (`androidx.profileinstaller` is fine — Apache-2.0 AndroidX, pulled by
  activity/appcompat/fragment/lifecycle. Its `ProfileInstallReceiver` names
  `android.permission.DUMP` as the permission a *caller* must hold; the app does
  not request DUMP and could not be granted it.) `com.google.code.gson` is also
  fine: Apache-2.0, no network.
- **Gate an Android-only plugin on `getPlatform() === "android"`, never on
  `isNativePlatform()`.** iOS is a native platform too, so an
  `isNativePlatform()` gate routes it into a `registerPlugin` proxy with no
  implementation behind it, and the call can only reject. Where the `catch`
  returns a safe default this merely hides a wasted round-trip; where the
  branch IS the feature it removes the feature with no fallback left. That is
  exactly how `exportNsec` came to return `"failed"` on iOS, which took the
  onboarding key backup (`backUpNsec`, the only route the signup wizard has)
  down with it — a generated nsec the user could not save anywhere. The list of
  plugins this applies to is `MainActivity.java`'s registrations MINUS the ones
  iOS also implements: `ArmadaNotification`, `ArmadaCredential`,
  `BluetoothMesh`, `WebReady`, `ShareTarget`. Cross-platform plugins (Share,
  Haptics, Clipboard, Filesystem, StatusBar, SecureStorage) are the case
  `isNativePlatform()` is actually for. `ArmadaDb` is now in neither group: it
  is implemented on Android AND iOS but nowhere else, so `hasNativeArmadaDB()`
  gates on an explicit platform SET plus `isPluginAvailable`. Gating it on
  `isNativePlatform()` would be wrong the day a third native platform appears;
  gating it on `"android"` would silently put iOS back on IndexedDB, with the
  data already written to SQLite left where nothing reads it.
- Commit messages: concise, imperative, sentence case (see `git log`).
  Describe the technical change only — what was changed. Don't embed a
  confident problem diagnosis, root-cause narrative, or prescribed "this fixes
  X" claim; state the behavioral effect plainly if needed, without asserting it
  as the definitive cause.
- Don't commit secrets, Android signing material (`*.jks`, `*.keystore`,
  `key.properties`), or `scratch/` (may hold invite secrets).
- Always commit after finishing a set of changes (don't wait to be asked); do
  not push unless asked. Verify the client builds (`npm run test`) before
  committing.
- **Never push to the `gitlab` remote.** When pushing (or releasing), push only
  to `origin`. The `gitlab` mirror is maintainer-managed manually.
- Touch ergonomics: interactive elements target ≥44px on touch devices via the
  `touch:` Tailwind variant (`@media (hover: none) and (pointer: coarse)`) —
  e.g. `size-9 touch:size-11`. Use `touch:` (real touch), not width
  breakpoints, so narrow desktop windows keep dense hover UI. Note `touch:`
  emits *before* `md:` in the cascade, so a class that shrinks at `md:` needs
  the stacked variant too: `size-9 md:size-7 touch:size-11 touch:md:size-11`.

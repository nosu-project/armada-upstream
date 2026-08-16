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

The optional self-hostable backend (LiveKit voice + Concord AV broker) and its
deployment/hosting docs live in the separate
[`armada-av`](https://gitworkshop.dev/chad@chadwick.site/relay.ngit.dev/armada-av)
repository — this client does not depend on it at build time. The NIP-29 side
needs no Armada-specific server at all: any NIP-29 relay serves it.

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
| `ios/ArmadaNotify/` | The decrypt/store/present pipeline the iOS Notification Service Extension runs (NIP-44/NIP-17/Concord, libsecp256k1 vendored). A SwiftPM package for the same reason — its suite runs on **Linux** |
| `electron/`  | Electron desktop shell (loads the bundled web build; Linux/Windows/macOS installers built in CI) |
| `docs/`      | Design notes too long for this file — currently `settings-documents.md` (the NIP-78 settings split) |
| `scripts/`   | Repo tooling, incl. two Concord-aware moderation-UX harnesses that mirror the same CORD-01/02/05 derivations: `scripts/spambot.mjs` (WRITES — chat spam with flood-fold evasion, plus kind-3313 direct-invite spam via `--invite-spam`) and `scripts/dump-community.mjs` (READS — resolves an invite and pages the decrypted Chat Plane out of the relays in `OpenedChat` shape, for feeding `floodCluster.ts`); see each file's header comment |
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
| `test.yml` | push (any branch) + PR | `npm run test` (tsc + eslint + vitest + build), both Swift suites (`swift test --package-path ios/{ArmadaDB,ArmadaNotify}`), and `npm audit --audit-level=high` |
| `deploy-web.yml` | push to `main` | build + rsync-over-SSH deploy of the hosted client (armada.buzz); skips deploy if the SSH secret isn't provisioned |
| `release.yml` | tag `v*` | signed Android APK + AAB, published as run artifacts and the APK to `armada.buzz/downloads/`, then Zapstore publish, then Google Play publish (draft release while the app is unpublished in Play Console; skips Play if the service-account secret isn't provisioned) |
| `desktop.yml` | tag `v*` | Electron Linux (AppImage + deb), Windows (NSIS + portable) and macOS (ad-hoc signed .app zips, cross-built); published as run artifacts and rsynced to `armada.buzz/downloads/` |
| `deploy-nsite.yml` | push to `main` + tag `v*` | build + `nsyte deploy` of the client as the named nsite `armada` (NIP-5A kind 35128) onto relays + Blossom; a tag additionally publishes an immutable kind-5128 manifest snapshot titled with the tag |

Notes specific to ngit-ci (vs the old GitLab pipeline):

- **No pipeline counter.** Android `versionCode` is derived from the semver tag
  as `major*1_000_000 + minor*1_000 + patch` (e.g. `v0.31.1` → `31001`).
  GitLab used `$CI_PIPELINE_IID` (last GitLab release v0.30.1 was code 402); the
  first ngit-ci releases used `10000 + git rev-list --count HEAD`, but ngit-ci's
  runner shallow-fetches only the tagged commit so the count was always 1 —
  every release got the same code and Zapstore silently dropped duplicates. The
  tag-derived scheme is deterministic, monotonic with semver, and independent of
  checkout depth. `versionName` is still the tag minus `v`.
- **The APK and the AAB are built by two separate gradle invocations, and only
  the APK is ABI-trimmed.** `release.yml` runs `bundleRelease` first, then
  `assembleRelease -PapkAbis=armeabi-v7a,arm64-v8a`. The AAB keeps all four
  ABIs because Play splits per device; the APK is universal, so its user
  downloads every ABI it contains — and `libsecp256k1-jni.so` +
  `libsqliteJni.so` are ~2.5 MB per ABI, which is what took the download from
  7 MB (v0.17, before either library) to 18.6 MB (v0.50). Dropping the x86 pair
  from the download cost 5 MB of nothing: they are emulators and a few
  Chromebooks, neither of which sideloads. Release builds are also **minified**
  (R8, `minifyEnabled true`) — 5.6 MB of dex to 1.3 MB. `proguard-rules.pro`
  documents what the reflective entry points need to survive that; the thing to
  re-check after adding a dependency or a plugin is that they still do, because
  R8 breakage is a runtime failure in the release build ONLY, which no debug
  install and no unit test will show you. `shrinkResources` stays off (~10 KB
  on a WebView app, against real risk).
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
`armada-av` (signaling protocol skew makes clients full-reconnect every
~16s). Full voice/LiveKit hosting guidance lives in `armada-av`'s `AGENTS.md`.

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
- **Export compliance lives in the comment at `ios/App/App/Info.plist`.** Read it
  before touching `ITSAppUsesNonExemptEncryption`; the position rests on Armada's
  source staying publicly available.

Android-only pieces that are simply absent on iOS, and are gated so they don't
surface dead UI or throw: the `ArmadaNotification` background relay service
(use `hasNativeNotificationService()`, not `isNativeRuntime()`, for anything
touching it), NIP-55 external signers (Amber), the Bluetooth mesh, and
the Credential Manager nsec export (itself Android 14+ only — see Conventions).

### Notifications: APNs through the same nostr-push gateway

iOS is the one platform that cannot listen for its own events in the
background — no equivalent of Android's foreground service, and no Web Push in
WKWebView — so it takes an APNs device token (`ios/App/App/ArmadaPushPlugin.swift`,
`src/lib/nativePush.ts`) and registers it with the SAME content-blind
nostr-push gateway the web client uses, as NIP-PUSH's `type: "apns"`
subscription. `useIosPush.ts` is the controller; it and `useNostrPush.ts`
register one watch set (`usePushWatchSet.ts`) and expose one
`UsePushNotificationsReturn`, so the settings UI never learns which it has.
Apple is unavoidably in the delivery path; what survives is that the GATEWAY
still matches kinds and tags and sends a fixed string, never a rendered
message.

- **The message is decrypted on the device, by the Notification Service
  Extension.** `ios/App/NotificationService` is the target; all of its work is
  in `ios/ArmadaNotify`, the THIRD port of the decrypt/store/present pipeline
  (`sw.js`+`pushRuntime.ts` on web, `Dm17.kt`+`ServiceStore.kt` on Android).
  The gateway inlines the matched event, the extension opens it, writes it into
  the same ArmadaDB the WebView reads — which is why the database was put in
  the App Group before anything was stored in it — and rewrites the
  notification from the plaintext. `standaloneNotification()` only fills the
  empty body the group scopes register, for the two ordinary ways an
  un-rewritten notification still reaches the screen: an event too large for
  the gateway to inline (best-effort, 4096-byte APNs payload) and a NIP-46/07
  login whose key never reaches the device. Deliberately NOT solved with
  NIP-PUSH's `{{content}}` template — that is resolved server-side, which would
  route message text through a gateway whose whole point is that it never
  handles plaintext.
- **`ios/ArmadaNotify` is a SwiftPM package so its suite runs on Linux**, like
  `ios/ArmadaDB` and for a sharper reason: this is the code that decides
  whether a rumor is authentic. Its vectors were generated with the very
  nostr-tools/@noble builds the web client uses, so a port that drifts from the
  app's own crypto fails `swift test --package-path ios/ArmadaNotify` (wired
  into `test.yml`) rather than in the field. libsecp256k1 is VENDORED
  (`Sources/CArmadaSecp256k1`, upstream v0.7.0, `extrakeys`+`schnorrsig` only),
  the same call SQLite gets. ECDH goes through `secp256k1_ec_pubkey_tweak_mul`,
  NOT the `ecdh` module, whose helper returns a SHA-256 OF the shared point
  while NIP-44 hashes the bare x — the same choice `NostrCrypto.java` makes.
  SHA-256/HMAC/HKDF/ChaCha20 are hand-written above the curve because NIP-44
  needs RAW ChaCha20 and CryptoKit exposes only ChaChaPoly; splitting the hash
  chain between CryptoKit and a fallback would leave the Linux suite testing
  code the extension does not run. **The counter starts at 0**, not the AEAD's
  1 — that alone is the difference between decrypting and garbage.
- **The extension is a separate process with its own sandbox.** It shares
  exactly one thing with the app, the App Group, so its entitlements must
  declare it and its own App ID must have it provisioned. Anything it needs to
  decrypt goes through `writeIosPushConfig` into
  `push-config.json` there, under `.completeUntilFirstUserAuthentication` —
  the weakest protection class that still works, because a push arrives while
  the device is LOCKED and anything stronger leaves the extension unable to
  read its own config. An nsec login puts `sk` there; a NIP-46 login puts the
  CLIENT key plus its bunker's pubkey/relays (`nip46`) and the extension asks
  the bunker to `nip44_decrypt` the wrap and the seal, over one socket, with
  the identity key never leaving the bunker — so a bunker that PROMPTS for
  decryption can never work here, since the push arrives with the device
  locked and no UI to approve anything. Both are deleted on disable/logout.
  **Always call the content handler exactly once**: an extension that returns
  without calling it, or crashes, silently shows the gateway's static text
  with no log anyone reads. It now has a genuine race to get that wrong —
  the avatar fetch below and `serviceExtensionTimeWillExpire` complete on
  different queues — so the call is behind a lock and a flag.
- **Presentation must not depend on persistence.** The store and the
  notification fail independently, so `PushProcessor` takes an OPTIONAL store:
  a database that will not open costs the message its history and its sender's
  name, and the text has already been decrypted by then. Gating the one on the
  other is not hypothetical — it shipped, and every push silently fell back to
  the gateway's static text because `NotifyStore()` returned nil.
- **A sender's face needs an `INSendMessageIntent`, not an attachment.** iOS
  shows the app icon on a notification unless it is a COMMUNICATION
  notification: donate the intent, rebuild the content with
  `UNNotificationContent.updating(from:)`, and the sender's avatar (or the
  monogram of their name) replaces it, with the conversation joining Focus
  modes' people rules. Needs the Communication Notifications capability on the
  App ID — automatic signing adds it, but without the entitlement
  `updating(from:)` throws and the notification degrades to the right text
  with the wrong icon, which looks like nothing is wrong. `PreparedPush.sender`
  is present only where the sender is ALREADY named in the body, which is what
  keeps a message request — whose whole point is that a stranger controls
  their own name and picture — from becoming a person on the lock screen.
- **The avatar is the one thing here that touches the network**, because the
  image has to be bytes in hand when the content handler is called; there is no
  URL the system will fetch for us. It is bounded on every axis (`https` only,
  4s, 256 KB) and cached per sender in the App Group (`AvatarCache`, keyed by
  the SHA-256 of the URL so a changed picture misses once and nothing has to
  invalidate anything), so it is a per-sender cost rather than a per-message
  one. Every failure ends at the monogram, never at a missing notification.
- **iOS cannot withdraw a delivered alert.** A push the pipeline decides is not
  news (the viewer's own message from another device, a reaction to someone
  else's) still has to show something, so it becomes a `passive` "Messages
  synced" rather than the gateway's "New message" — which would be a
  notification about nothing.
- **`aps-environment` is a runtime question, not a build flag.** A device token
  is minted against exactly one APNs host and the other rejects it with
  `BadDeviceToken` — and a Release build run from Xcode is still sandbox while
  the same configuration through TestFlight is production, so neither
  `#if DEBUG` nor a build setting can answer it. `ArmadaPushBridge` reads the
  `aps-environment` entitlement back out of the app's own embedded
  provisioning profile and sends it with the token; an App Store build embeds
  no profile, which is itself the production answer. Requires Push
  Notifications on the App ID, like Associated Domains and App Groups.
- **Subscription ids carry an installation id.** nostr-push indexes
  `subscription_id` globally and registering REPLACES, and the native builds
  have no origin of their own worth naming so they share `armada.buzz` as their
  `domain` with the hosted client. Without the extra dimension
  (`pushInstallationId`), signing in on an iPhone would silently take over the
  same account's browser records and the browser's next sync would take them
  back. Two BROWSERS on one origin still collide this way; that is pre-existing
  and left alone, because changing web ids would make every install prune and
  re-register.
- **The gateway is build-time config, and iOS has no CI to set it.**
  `VITE_NOSTR_PUSH_PUBKEY` / `VITE_NOSTR_PUSH_RELAYS` must be in the
  environment of the `npm run build` that precedes `npx cap sync ios`, or the
  app ships with `unavailableReason: "gateway"` and no push path at all.
- Taps are routed by the plugin, not by a URL. A tap that LAUNCHED the process
  is buffered natively and read by `coldLaunchDeepLink` alongside the launch
  URL, so both settle the one race against `HomeRedirect`; a warm tap is the
  `pushOpened` listener in `useNotificationNavigation`. Only DMs name a
  destination — a group/community wake-up carries no room id, the gateway being
  content-blind. A push arriving while the app is open lands in Notification
  Center without a banner or sound, since the payload cannot distinguish the
  channel being read from any other.

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
ONLY by the Android notification service's PendingIntents, and iOS push taps
reach the router through the plugin rather than through a URL, so nothing on
iOS can produce one.

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
- **A burst is one statement per table, not one per rumor** — and on SQLite
  that is most of what a write costs. `rumors` carries an AFTER INSERT trigger
  maintaining the content index, and SQLite runs a trigger's sub-program per
  INSERT STATEMENT rather than folding it into the row loop, so a row per
  statement paid that setup once per rumor: 76µs a row against 17µs for the
  same rows, the same trigger and the same transaction written in batches of
  200. `flushWrites` therefore STAGES a burst (`RumorBatch`) and emits one
  multi-row INSERT per table per chunk — measured 287µs → 61µs per NIP-17
  rumor, and 4.0 → 1.0 statements. Two things it must keep doing, and the
  Kotlin and Swift ports with it: a rumor that READS the rows around it (a
  replaceable one superseding its coordinate, a kind 5 deleting its targets)
  flushes the batch and writes alone, so it still sees everything before it and
  nothing after; and the rowid ledger lives in the batch, because a rowid
  reserved for a staged row is invisible to the `MAX(seq)` that reserves the
  next one. Both are in `ArmadaDB.test.ts`, so a port that skips either fails
  the conformance suite rather than the field. The per-rumor `INSERT OR IGNORE`
  into `rumor_terms` went the same way — a NIP-17 message is filed under three
  terms, which alone tripled a write's statements.
- **A term read that names anything else is planned by COUNTING, on
  IndexedDB.** A derived term lives in the index and nowhere else, so the
  moment a filter names a term plus anything, `NIndexedDB` has to be asked for
  a superset and narrowed here (`runChecked`) — and which superset is smaller
  is a property of the data. A thread page is the term, since every kind in the
  filter is in the thread; the same thread's TIMER is the kind, one row per
  conversation against every message ever sent in one. One index-only `count`
  each decides it, and the limit is PAGED rather than dropped — reading the
  range whole made a 50-row page of a 300-message thread deserialize the whole
  thread. The paging must stay exhaustive: it is a walk to the end of the
  range, not a search budget, or a timer set a year ago is reported as no timer
  at all.
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
  conversation comes from `pubkey` and the `p` tags NIP-17 requires
  (`dmPeersOf`), and where the derivation is more than a filter can express it
  becomes a derived TERM rather than a tag (see below). A Concord plane is its
  KINDS
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
- **Where the derivation is real but unfilterable, index a TERM.** A NIP-01
  filter can only ask about what a rumor literally says, and a NIP-17
  conversation is the SET of its participants — half in `pubkey`, half in the
  `p` tags, and a tag filter is an OR over values, so `authors: [ana, ben]` also
  matches everything Ana sent in another room. Every such read could therefore
  only OVER-select and be narrowed in JavaScript afterwards, at a fixed 3×
  over-fetch per filter. A tenant may instead declare a `TermPolicy` (`db/types.ts`):
  a pure function of the stored rumor returning opaque strings, indexed beside it
  and looked up as a NIP-50 extension token (`{ search: "conv:<key>" }`). Not a
  tag on the rumor and not a row impersonating one — a CACHE of a derivation,
  discardable and rebuildable, unforgeable by a sender spelling anything, and
  read by nothing but the index. Three rules make it safe: the ENGINES never
  interpret a tenant id or a term (`db/termPolicies.ts` is the only table that
  does, and `TermPolicies.kt` / `TermPolicies.swift` must agree with it exactly);
  the policy binds to the TENANT, not to a write, so the Android service and the
  iOS extension file rows correctly while knowing nothing about terms; and an
  unknown term FAILS CLOSED, matching nothing rather than dropping the
  constraint. SQLite gets a b-tree (`rumor_terms`, schema v2) rather than more
  FTS tokens because `(tenant, term, seq)` is already time-ordered, so a lookup
  is a bounded backwards walk — and because a b-tree can be GROUPED, which is
  what `distinct:` below is. Existing rows are indexed by a one-time per-tenant
  backfill, since a term cannot be derived in SQL; only reads that TOUCH the
  index wait for it — which is every read carrying a `search`, and must be
  tested that way rather than on the terms the filter parsed to, because
  `distinct:` reaches the index while naming no term of its own. (Gating on the
  parsed terms is what left the Kotlin and Swift engines answering the
  conversation list from an index nothing had built.) The GENERATION that walked
  the tenant is recorded beside it — one number, identical in all three ports,
  because a policy edit without it leaves earlier rows carrying terms nothing
  looks up, and two ports that disagree rebuild the index against each other on
  every open. A pass runs at most once per tenant per process whatever the
  outcome, and a failed one is swallowed with its generation unrecorded: the
  read that triggered it is answerable from the index as it stands, and the next
  launch walks the tenant again.
- **`distinct:<namespace>` collapses a read to one rumor per group.** A term is
  namespaced (`<namespace>:<body>`, which the read path always required since a
  term is named as a `key:value` token), and this reserved token returns the
  NEWEST rumor per term in one namespace — so `limit` counts conversations while
  still counting rows. ditto-relay spells the same operation `distinct:author`
  over a field, and for the same reason: collapsing has to happen INSIDE the read,
  because de-duplicating the answer afterwards can only shrink an already
  truncated page. That was the NIP-17 conversation list, which sampled the newest
  500 message rumors and grouped them in memory — one busy thread hid every other
  conversation, and a peer written to a year ago fell out of the `mine` set the
  push gateways read as "not a stranger". Two plans, which must answer
  identically: `GROUP BY term` over the namespace's range (index-only, one body
  read per group) when nothing outside the term index has to be tested, and a
  collapse-as-you-scan otherwise — row conditions apply BEFORE the collapse, so
  `kinds` would have to be tested inside the grouping, which is why the policy
  files a message-only namespace (`convmsg:`) instead. It is a DIRECTIVE, not a
  term: query-only (a `remove()` naming it deletes nothing, since "one rumor per
  conversation" is not a deletion anyone should be able to ask for), never
  matched row-wise, and refused outright rather than approximated — two of them,
  or a namespace that isn't one, fail closed.
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
  data already written to SQLite left where nothing reads it. The rule runs the
  other way too: `ArmadaPush` is iOS-ONLY, so `hasIosPush()` gates on
  `getPlatform() === "ios"` plus `isPluginAvailable` — the second half because
  an iOS build predating the plugin would otherwise offer a toggle whose every
  call rejects. Android needs no such plugin and should never get one: the APK
  ships no Play Services to receive FCM on, and its background service is
  strictly better anyway, holding the relay sockets itself with no third party
  in the delivery path.
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

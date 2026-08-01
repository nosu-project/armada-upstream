# AGENTS.md

Guidance for agents working on the **Armada client** — the web app (repo root),
the Capacitor Android project (`android/`), the Capacitor iOS project (`ios/`),
and the Electron desktop shell (`electron/`).

Armada's focus is [Concord](https://github.com/concord-protocol/concord):
serverless, end-to-end encrypted communities that need no host. The client also
still supports NIP-29 relay-based "servers" for operators who self-host. The
optional self-hostable backend (NIP-29 relay + LiveKit voice + Concord AV
broker) and all deployment/hosting docs live in the separate
[`armada-relay`](https://gitlab.com/soapbox-pub/armada-relay) repository — this
client does not depend on it at build time.

## Repo layout

| Path         | What                                                            |
|--------------|-----------------------------------------------------------------|
| `src/`       | React 19 + Vite web client (Tailwind + shadcn/ui + Nostrify)    |
| `src/concord-v2/` | The Concord protocol implementation (CORD-01..07): stream, control, chat, invites, rekey, voice, crypto derivations |
| `src/lib/db/` | ArmadaDB — the one local storage interface (tenants of rumors + a KV), its IndexedDB adapter, the Android bridge adapter, and the migrations |
| `android/`   | Capacitor Android project (signed APK/AAB built in CI)          |
| `android/…/app/db/` | ArmadaDB in Kotlin: the SQLite engine the Android build actually runs, shared by the WebView and the notification service |
| `ios/`       | Capacitor iOS project (SwiftPM, no CocoaPods; built manually on a Mac — no CI) |
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
| `test.yml` | push (any branch) + PR | `npm run test` (tsc + eslint + vitest + build) and `npm audit --audit-level=high` |
| `deploy-web.yml` | push to `main` | build + rsync-over-SSH deploy of the hosted client (armada.buzz); skips deploy if the SSH secret isn't provisioned |
| `release.yml` | tag `v*` | signed Android APK + AAB, published as run artifacts, then Zapstore publish, then Google Play publish (draft release while the app is unpublished in Play Console; skips Play if the service-account secret isn't provisioned) |
| `desktop.yml` | tag `v*` | Electron Linux (AppImage + deb) and Windows (NSIS + portable) |

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
  (+ optional `DEPLOY_SSH_CONFIG_BASE64`, `DEPLOY_TARGET`, `VITE_PLATFORM_RELAYS`).
  Optional: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (base64 of the Play Console
  service-account JSON for `buzz.armada.app`; unprovisioned skips the Play
  publish); `KLIPY_API_KEY` (switches GIF search from the keyless GIFverse
  default to KLIPY; unprovisioned keeps GIFverse).
- **No macOS.** act runs Linux containers only; the macOS `.dmg` and the GitLab
  Release / generic-package links stay on the GitLab mirror (`.gitlab-ci.yml`)
  until switch-over. Keep `.gitlab-ci.yml` working as a mirror; do not delete it
  yet.
- **act images are minimal.** They are not full GitHub-hosted runners: use setup
  actions (`actions/setup-node`, `setup-java`, `android-actions/setup-android`)
  and install anything else explicitly (e.g. `rsync`, `wine`).
- **`ubuntu-latest` runs in a pre-baked `armada-ci` image.** The coordinator
  maps the label to it via `NGIT_CI_ACT_PLATFORMS`; the Dockerfile lives in
  `.ngit/ci-image/` and pre-installs the JDK/node toolcaches (setup-* actions
  no-op), the Android SDK, system ruby+fastlane, the zsp binary, wine, and
  warm `~/.gradle` (incl. build cache) / `~/.npm` /
  `~/.cache/electron{,-builder}` caches for this repo. Cold runs on the stock
  act image re-downloaded ~700 MB of toolchain+deps and blew the coordinator's
  30-min default job timeout (`NGIT_CI_JOB_TIMEOUT_SECS`, raised to 3600
  server-side). Rebuild with `.ngit/ci-image/build.sh` on the coordinator host
  when `package-lock.json`, `electron/package-lock.json`, or the android/gradle
  deps change; the setup-* actions self-heal version drift in between.
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
  building both platforms). Job containers are capped by
  `NGIT_CI_ACT_CONTAINER_OPTIONS` (currently `--cpus=8 --memory=10g`).

## How the client reaches backends (no build-time coupling)

The client talks to relays and voice brokers over **runtime-configurable URLs**,
never a compiled-in server address:

- Relay/server traffic is Nostr over WebSocket to user-added / configured relays.
- The relay's HTTP endpoints (NIP-29 LiveKit token, push) are derived at runtime
  from the relay's WS URL via `relayToHttpUrl()` in `src/lib/platform.ts`.
- Concord voice (CORD-07) fetches LiveKit tokens from a blind AV broker,
  defaulting to `VITE_CONCORD_AV_SERVERS` (public `https://armada.buzz`).

`VITE_PLATFORM_RELAYS` is **empty** in the shipped APK/desktop/dev builds — a
fresh client has no baked-in servers and the user adds their own. Never pin
`ws://localhost` (meaningless on a phone).

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

- **Don't pass `CODE_SIGNING_ALLOWED=NO`** even for the simulator. An unsigned
  app has no keychain-access-group entitlement, so every
  `capacitor-secure-storage-plugin` write fails (`errSecMissingEntitlement`,
  surfacing as a bare `"error"`) — which is where the nsec lives. Xcode's
  default ad-hoc simulator signing is enough; a device/store build needs a
  team + provisioning profile (not configured in-repo).
- The WebView origin is `capacitor://localhost` (Android uses
  `https://localhost`). Changing `server.iosScheme` later would move the
  origin and orphan all IndexedDB/OPFS/localStorage data, so treat it as
  fixed. `shareOrigin()` already returns the public web origin on native.
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

Android-only pieces that are simply absent on iOS, and are gated so they don't
surface dead UI or throw: the `ArmadaNotification` background relay service
(use `hasNativeNotificationService()`, not `isNativeRuntime()`, for anything
touching it), NIP-55 external signers (Amber), the Bluetooth mesh, and
the Credential Manager nsec export. **iOS therefore has no notifications at
all** — no background service, and no Web Push in WKWebView; that needs APNs or
a native iOS equivalent. Deep links are also unhandled: there is no
`CFBundleURLTypes` entry and no `applinks:armada.buzz` associated-domains
entitlement (the latter needs a paid team + `apple-app-site-association`), so
`armada://` and armada.buzz universal links won't open the app yet. The JS
layer (`deepLinkUrl.ts`, `coldLaunchDeepLink.ts`) is platform-agnostic and
needs no change when they're added.

## Local storage: ArmadaDB

One interface (`src/lib/db/types.ts`) — tenants of rumors plus a KV — with a
different engine per platform:

| Platform | Engine |
|----------|--------|
| Web / desktop / iOS | `IndexedDBArmadaDB` (Nostrify's `NIndexedDB` per tenant) |
| **Android** | `NativeArmadaDB` → `ArmadaDbPlugin` → **Kotlin** (`android/…/app/db/`) |

On Android the query engine is native and there is exactly one database file.
The background notification service writes an event into the same tenant the
WebView reads it from, so a message received while the app was dead is simply
*there* on open. `drainEvents`/`ackDrain` still exist but are ROUTING only — a
pass through wire ingest (parking wraps, ringing scopes, notification
candidates) — over a `svc` queue tenant, not the path by which anything becomes
durable.

Things to know before touching it:

- **The Kotlin port must stay in step with `SqliteArmadaDB.ts`.** Same schema,
  same `seq = created_at × 2²⁰ + n` rowid encoding, same tag-token escaping,
  same planner. `ArmadaDbTest.kt` is the TS conformance suite ported over; run
  it (`cd android && ./gradlew :app:testDebugUnitTest`) for any change to
  either.
- **SQLite is bundled, not borrowed.** The schema needs FTS5 with
  `contentless_delete` (3.43+) and JSON1; Android's platform SQLite is 3.9 on
  minSdk 24 and has neither. `androidx.sqlite:sqlite-bundled` ships 3.50.1 per
  ABI (~1.2 MB each, ~5 MB on a universal APK) and the same build for the JVM,
  which is what lets the conformance suite run the real engine as a plain unit
  test.
- **The adapter is chosen before anything reads.** The legacy drains in
  `migrations.ts` write through `getArmadaDB()`, so on Android they land in the
  native store directly — there is no IndexedDB ArmadaDB to move, and adding a
  second hop would be a second chance to strand decrypted Concord and NIP-17
  history that exists nowhere else.
- **The service is a second writer, so it obeys the same store rules.** `Dm17.kt`
  ports NIP-17's kind filter, NIP-40 expiry refusal and `peer` attribution;
  `ServiceStore.storeConcord2Rumor` ports the Concord provenance tags and the
  refusal of a rumor that forges them. A rule only one writer applies is a
  conversation the two disagree about.
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
  reintroduce any automatic list publish, however well-intentioned.
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

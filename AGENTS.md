# AGENTS.md

Guidance for agents working on the **Armada client** — the web app (repo root),
the Capacitor Android project (`android/`), and the Electron desktop shell
(`electron/`).

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
| `android/`   | Capacitor Android project (signed APK/AAB built in CI)          |
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
| `release.yml` | tag `v*` | signed Android APK + AAB, then Zapstore publish |
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
- **No macOS.** act runs Linux containers only; the macOS `.dmg` and the GitLab
  Release / generic-package links stay on the GitLab mirror (`.gitlab-ci.yml`)
  until switch-over. Keep `.gitlab-ci.yml` working as a mirror; do not delete it
  yet.
- **act images are minimal.** They are not full GitHub-hosted runners: use setup
  actions (`actions/setup-node`, `setup-java`, `android-actions/setup-android`)
  and install anything else explicitly (e.g. `rsync`, `wine`).

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

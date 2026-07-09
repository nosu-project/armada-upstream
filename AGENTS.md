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

- Commit messages: concise, imperative, sentence case (see `git log`).
- Don't commit secrets, Android signing material (`*.jks`, `*.keystore`,
  `key.properties`), or `scratch/` (may hold invite secrets).
- Always commit after finishing a set of changes (don't wait to be asked); do
  not push unless asked. Verify the client builds (`npm run test`) before
  committing.

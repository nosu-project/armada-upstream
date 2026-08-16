# Armada

> **Canonical repository:** [gitworkshop.dev/soapbox.pub/armada](https://gitworkshop.dev/soapbox.pub/armada) — the GitLab repository is a read-only mirror.

Discord without the company. **No host required.** Your keys, your people.

Armada is an end-to-end encrypted community chat app built on
[Nostr](https://github.com/nostr-protocol/nostr) — servers, channels, threads, voice, and moderation,
everything you expect from a chat app. Nobody can read your messages, sell your
data, or shut your community down.

Communities are serverless by default, built on
[**Concord**](https://github.com/concord-protocol/concord): a serverless,
end-to-end encrypted community protocol. Spin up a community with nothing to set
up and nobody in the middle — text channels, live voice rooms, and invites, all
without running a server. Communities ride as gift-wrapped Nostr events over
ordinary relays; only members can read them.

Armada also supports [NIP-29 relay-based
groups](https://github.com/nostr-protocol/nips/blob/master/29.md) for operators
who want a **relay-backed server** that owns membership, moderation, and data —
point the client at any NIP-29 relay.

This repository is the **client** — the web app (React 19 + Vite + Tailwind +
shadcn/ui + Nostrify), the Capacitor Android project (`android/`), and the
Electron desktop shell (`electron/`). It does not depend on the backend at build
time; it talks to relays and voice brokers over runtime-configurable URLs.

## Concepts

- **Concord communities** — serverless, E2EE. All control/chat/invite/rekey
  traffic is gift-wrapped (NIP-59) over generic Nostr relays; voice uses a blind
  LiveKit token broker (CORD-07) that learns nothing about the community. The
  full protocol lives client-side under `src/concord/`. Armada's
  client-specific Concord conventions are documented in
  [CORD.md](CORD.md), the CORD analog of a project's `NIP.md`.
- **NIP-29 servers** — relays act as servers; channels are NIP-29 groups.
  Requires a relay to point at (use any external NIP-29 relay).
- **Auth** — sign in with your key: nsec, NIP-07 extension, or NIP-46
  bunker/nostrconnect. Your identity is portable across devices.
- **App relays** — configurable general-purpose relays for non-community traffic
  (profiles, lists). Defaults to `relay.ditto.pub` + `relay.dreamith.to`;
  editable in Settings and at build time (`VITE_APP_RELAYS`).
- **Voice** — WebRTC audio via LiveKit, E2E-encrypted client-side under
  per-sender keys.

## Development

```sh
npm install
npm run dev        # http://localhost:8080
npm run test       # tsc + eslint + vitest + production build
```

Voice requires a secure context for microphone access: `localhost` works out of
the box; other hostnames need HTTPS.

### Configuration (build-time env)

- `VITE_KLIPY_API_KEY` — **optional.** GIF search uses the keyless GIFverse
  provider by default. Set this to switch GIF search to KLIPY instead; leave it
  empty (the default) to keep GIFverse. KLIPY additionally sends a per-install
  `customer_id` on every request and injects sponsored results, which is why it
  is opt-in. Set it in CI as the repository secret `KLIPY_API_KEY`, or in
  `.env.local` for local development. Like every key used by a browser-only API
  integration, it is embedded in the compiled client bundle; keeping it in a
  secret keeps it out of source/history, not out of browser developer tools.
  Configure any available platform restrictions in KLIPY's partner panel.
- `VITE_APP_RELAYS` — default app relays for non-community traffic — profiles
  (kind 0), group lists (kind 10009) — in the style of Ditto's app relays
  (default `wss://relay.ditto.pub,wss://relay.dreamith.to`); users can edit the
  list in Settings, including removing all of them for air-gapped use.
- `VITE_BROADCAST_RELAYS` — write-only relays (default `wss://relay.primal.net`).
  Everything the general relay pool publishes — the profile, the user's personal
  lists — is sent here in addition to the app relays, so other Nostr clients
  that index these relays can find it; nothing is ever read from them, and
  community, group and direct-message traffic never routes here. User-editable
  in Settings, and turned off along with the app relays. Set it empty to publish
  nowhere but the app relays.
- `VITE_SEARCH_RELAYS` — relays used for NIP-50 full-text search (profile /
  mention autocomplete); `search` filters route only to these (default
  `wss://relay.ditto.pub,wss://relay.dreamith.to`). User-editable in Settings;
  when empty, search falls back to the app relays.
- `VITE_NIP65_DISCOVERY_RELAYS` — comma-separated public NIP-65 indexes queried
  once after login to locate the user's signed kind-10002 read/write relay list
  (default `wss://purplepag.es,wss://user.kindpag.es,wss://relay.nos.social`).
  These are discovery-only: they never enter the general pool or receive normal
  account traffic. Set it empty to use only the app relays and user-entered
  bootstrap hints for discovery.
- `VITE_APP_BLOSSOM_SERVERS` — comma-separated default Blossom media servers
  (BUD-03) uploads fall back to, in the style of `VITE_APP_RELAYS` (default
  `https://blossom.ditto.pub/,https://blossom.dreamith.to/,https://blossom.primal.net/`).
  User-editable in Settings, and can be turned off entirely with the "Use app
  media servers" toggle.
- `VITE_CONCORD_AV_SERVERS` — fallback Concord voice (CORD-07) token brokers
  (default `https://armada.buzz`).
- `VITE_BRIDGE_PORTAL_URL` — origin of a Discord bridge portal
  (`armada-discord-bridge`), e.g. `https://bridge.armada.buzz`. **Empty by
  default**, which hides every Discord affordance in the client; set it and the
  "Import a Discord server" buttons appear on the Add dialog, the welcome page,
  the Discover grid, and community settings. It is only the target of links the
  user clicks — nothing is dialed on boot and no Armada data is sent to it. The
  import itself runs on the portal, which signs the resulting community with the
  user's own Nostr key and hands back an ordinary invite link. Must be an
  `http(s)` URL; anything else is treated as unset.
- `VITE_NOSTR_PUSH_PUBKEY` / `VITE_NOSTR_PUSH_RELAYS` — identity of a
  content-blind NIP-PUSH gateway and the comma-separated Nostr relays used for
  its encrypted RPC. When configured, web and Home-Screen installs can receive
  standards-based Web Push while Armada is closed; when empty, background Web
  Push is unavailable. These values are public client configuration (Vite
  embeds them in the bundle), even when deployment CI supplies them as secrets.
- `VITE_APP_NAME` — display name.

## Packaging

- **Android** — Capacitor project in `android/`. `npx vite build && npx cap sync
  android`, then build with Gradle. CI produces a signed APK/AAB on `vX.Y.Z`
  tags.
- **Desktop** — Electron shell in `electron/`. Bundles the web build and serves
  it over a custom secure scheme. CI produces Linux/Windows/macOS installers on
  tags.
- **Web** — `Dockerfile` (nginx-served static build) + `nginx.conf`.

## License

[AGPL-3.0](LICENSE)

### Additional permission for app store distribution

App stores make you agree to terms (device limits, DRM) that section 10 of the
AGPL forbids adding on top of it, so shipping an AGPL app through one needs an
explicit additional permission from the copyright holder:

> As an additional permission under section 7 of the GNU Affero General Public
> License version 3, Soapbox Technology LLC grants permission to convey the
> Program, and works based on it, through Apple's App Store and any other
> application distribution platform, notwithstanding the additional
> restrictions those platforms' terms of service impose on the recipient's
> exercise of the rights granted by this License.

This does not narrow the AGPL, and section 7 lets any recipient remove it from
their own copy.


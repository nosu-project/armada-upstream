# Changelog

All notable changes to Armada are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and releases are tagged
`vX.Y.Z`.

## [0.4.3] - 2026-06-23

A server's name, avatar, and channel list now stick around on a shaky or
dropped connection instead of collapsing to a bare address and a blank list.
The server's details are remembered on your device and shown immediately, even
when the network is struggling to reach it.

### Fixed
- Server name and avatar no longer disappear (replaced by the raw address and a
  placeholder icon) when the connection is flaky; the last-known details are
  remembered and shown instantly.
- The channel list no longer blanks out just because fetching the server's
  name/icon failed; it stays visible as long as the channels are known.

## [0.4.2] - 2026-06-23

Your channel list no longer reloads itself in the background. It now loads
instantly from your device and stays put, instead of refetching every minute
and flickering when you switch servers or reload.

### Fixed
- The channel list stopped constantly refetching. It loads instantly from local
  storage, no longer polls in the background, and only refreshes when a channel
  is actually created or changed.

## [0.4.1] - 2026-06-23

Fixes the Windows desktop app, which opened to a blank screen on first launch
and then wouldn't load your existing servers after signing in — leaving you
stuck on the "add a server" screen. Also keeps a message's hover toolbar from
overlapping the text on grouped messages.

### Fixed
- Windows desktop app no longer opens blank on first launch; signing in now
  correctly restores your existing servers instead of stranding you on the
  add-a-server screen.
- The hover toolbar on grouped (continuation) messages no longer covers the
  message text.

## [0.4.0] - 2026-06-23

Your chats now stick around when you reload. Armada keeps your conversations,
channels, communities, and profiles on your device, so a refresh shows
everything instantly instead of going blank while it reconnects. The welcome
and post-login screens also got a cleaner, refreshed look.

### Added
- Offline history: your messages, direct messages, encrypted communities,
  joined channels, and profiles are saved on your device and load instantly on
  refresh, even before the network reconnects.

### Changed
- Refreshed the welcome and post-login screens with a cleaner look and a
  step-by-step sign-in progress view.

## [0.3.1] - 2026-06-23

Logging in now shows a brief loading screen while Armada catches up — pulling
your settings, your channels, and recent messages — so the app opens ready to
use instead of filling in piece by piece. This release also fixes standalone
(non-hosted) clients that wrongly showed a phantom local server that didn't
exist.

### Added
- A post-login loading screen that syncs your settings, channel list, and
  recent messages before dropping you into the app, so nothing pops in late.

### Fixed
- Standalone clients no longer show a bogus "localhost" server that isn't
  reachable; they now correctly start with no servers until you add one.

## [0.3.0] - 2026-06-23

The Android app now delivers instant push notifications on its own — no Google
or third-party push service involved. Messages, mentions, replies, reactions,
direct messages, and community voice channels all ping you the moment they
arrive, even when Armada is closed, signed in with any login method. This
release also polishes the mobile experience with a branded launcher icon and
splash screen and fixes several layout glitches.

### Added
- Instant native push notifications on Android, delivered directly without
  Google/FCM: messages, mentions, replies, reactions, direct messages, and
  community channels. Works with any login method (key, signer, or remote
  signer) and notifies you even when the app is closed.
- A branded Armada launcher icon and splash screen on Android.

### Fixed
- Mobile layout fixes: safe areas around notches and system bars, the
  logged-out landing screen, and a screen that could get stuck loading.

## [0.2.1] - 2026-06-22

Push notifications are now on by default — once you allow notifications, Armada
keeps them enabled automatically across reloads and devices, so you don't have
to turn them back on.

## [0.2.0] - 2026-06-22

The desktop app is now a true standalone client — it isn't tied to any single
server. Add whatever servers you want; nothing is baked in. It also gains a
system tray (close to tray, an unread badge, and launch-minimized) and screen
sharing on desktop.

### Added
- Standalone desktop app: a fresh install starts with no servers and a welcome
  screen to log in and add your own — your client, your servers.
- System tray on desktop: closing the window keeps Armada running in the tray,
  with a Show/Quit menu, an unread badge, and the option to launch minimized.

### Fixed
- Screen sharing now works in the desktop app, with a picker to choose which
  screen or window to share.

## [0.1.2] - 2026-06-22

A maintenance release fixing the Windows desktop build image in CI. No
user-facing changes.

## [0.1.1] - 2026-06-22

A maintenance release that gets the desktop (Linux/Windows) installers building
in CI. No user-facing changes.

## [0.1.0] - 2026-06-22

The first tagged release of Armada — a sovereign harbor on the open relays, with
servers, channels, and voice. This release brings push notifications and native
desktop apps alongside the existing mobile app, so you stay reachable wherever
you are.

### Added
- Push notifications for messages, mentions, replies, reactions, and direct
  messages — delivered straight from your own server, so you get pinged even
  when Armada is closed. Choose exactly what you're notified about in Settings,
  Discord-style.
- Desktop apps for Linux and Windows (with a manual macOS build), published
  alongside the Android app on every release.
- End-to-end-encrypted voice for Concord communities, plus a redesigned in-call
  stage: screen sharing with a focus/spotlight mode and a theater layout.

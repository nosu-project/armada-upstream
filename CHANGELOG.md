# Changelog

All notable changes to Armada are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and releases are tagged
`vX.Y.Z`.

## [0.8.0] - 2026-06-25

Notifications now tell you who did what. On Android, a message, mention, reply,
or reaction shows the sender's name and avatar, the reaction's actual emoji, and
a preview of the message — instead of a generic "someone reacted." Settings has
been redesigned into clean grouped sections, communities and direct messages
open instantly from a local cache, and there's a new recovery tool to restore
encrypted communities that went missing from your list.

### Added
- Recover encrypted communities that dropped off your list: an advanced settings
  tool scans your local cache, every copy of your list across relays, and your
  invites to find communities you've lost, then lets you choose which to restore.

### Changed
- Notifications now show the sender's name and avatar, the emoji someone reacted
  with, and a preview of the message, so you can tell at a glance who did what.
- Settings has been redesigned into grouped sections with cleaner labels and
  rows, and the theme builder now opens in a dialog.
- Communities, channels, and direct messages now open instantly from a local
  cache and refresh in the background, removing the loading skeletons on a cold
  start.
- Refined the login, signup, and community settings dialogs.
- Refreshed the app icon to a cleaner mark.
- Logging out of your last account now wipes cached data from the device, and
  private pages can no longer be reached once you're signed out.

### Fixed
- Desktop and Android builds no longer show a phantom "localhost" server when no
  relay is configured.

## [0.7.0] - 2026-06-24

Plan together and share what you're up to. Admins and moderators can now create
date- and time-based events in a channel, and any member can RSVP Going, Maybe,
or Can't go with live attendee tallies. Set a personal status that shows next to
your name across the member list and profile cards. On Android, Armada now asks
to turn on notifications right when you open it instead of leaving them buried
in Settings, and you can point your direct messages at your own relays.

### Added
- Channel events: admins and moderators can schedule date- and time-based
  events in a channel, and any member can RSVP Going, Maybe, or Can't go.
  Upcoming events appear in a slide-down bar from the channel header with live
  attendee counts.
- Personal statuses: set a short status (with an optional emoji) that shows next
  to your name in the member list and on profile cards. Set or clear it from the
  account menu or your own member-list menu.
- Direct messages can now use your own relays: when you turn this on, Armada
  picks up the direct-message relays you've already published and keeps them in
  sync so other apps know where to reach you.

### Changed
- On Android, Armada now prompts to enable notifications when you first open the
  app, rather than only offering the toggle in Settings.

## [0.6.0] - 2026-06-24

Better interop with other community chat apps, plus faster and more reliable
loading. Encrypted images shared from other clients now decrypt and display
inline, and images you send are encrypted to match. Community names, icons, and
member lists now paint instantly from a local cache on refresh instead of
reloading from scratch, and avatars and names fill in more reliably. Owners and
admins are now distinguished in the member list.

### Added
- Encrypted images shared from other community chat apps now decrypt and display
  inline, and images you send are encrypted the same way so they show correctly
  for everyone.
- Encrypted community icons and banners now display in the server rail, header,
  and sidebar.
- Owners and admins are distinguished in the member list with separate badges (a
  crown for owners, a shield for admins).

### Changed
- Community names, icons, and member lists now paint instantly from a local
  cache when you refresh, instead of reloading from scratch each time.
- New messages in communities now appear live, and busy rooms load faster.
- Avatars and display names fill in more reliably instead of occasionally
  freezing as missing for several minutes.

### Fixed
- Member roles and permissions set by owners and admins now resolve correctly
  for communities created in other apps.
- The invite prompt no longer pops up for communities you have already joined
  while the app is warming up.

## [0.5.2] - 2026-06-24

A community chat fix-up release. Accepting several invites in a row no longer
wipes your community list, custom emoji now show as images in community
messages and reactions, image attachments with malformed links from some media
servers are repaired automatically, and busy community rooms are noticeably
smoother.

### Fixed
- Accepting several community invites back to back could wipe your community
  list (and lose access to those rooms); invites are now accepted safely in
  sequence.
- Custom emoji now render as images in community messages and reactions instead
  of showing as raw `:shortcode:` text.
- Image and file attachments that came back from some media servers with a
  malformed link are now repaired, so they preview and send correctly.
- Active community rooms with lots of messages and reactions are much smoother;
  the message list no longer redraws everything on each new message.

## [0.5.1] - 2026-06-24

A polish release for dialogs and message actions. Every dialog now shares the
same cut-corner "chrome" look, their headings scale to fit, and tall dialogs
scroll instead of running off the screen on phones. On smaller desktop and
tablet windows, the per-message action buttons no longer float out of place or
become unclickable.

### Changed
- All dialogs share a consistent cut-corner style, with headings that scale to
  fit so they no longer overflow on narrow screens.

### Fixed
- Dialogs that are taller than the screen now scroll instead of overflowing off
  the bottom on mobile.
- The hover toolbar on a message could float out of place and become unclickable
  on smaller desktop and tablet windows; its buttons now stay aligned and
  clickable, and the "(edited)" marker no longer overlaps them.

## [0.5.0] - 2026-06-24

A big release for serverless communities. You can now run a community end to
end without a server in charge: edit its name, description, logo, and banner;
create and rename channels; build custom roles and hand out fine-grained
permissions; and moderate with kick, ban, unban, and hide. Communities support
message editing and live "someone is typing" indicators, and invite links can
carry an expiry (never, 1, 7, or 30 days) and a label, and be revoked so a
shared link stops working. Owners can permanently dissolve a community. Adding
and inviting people got a fresh look, with a smart paste box that accepts links,
invite tokens, or a bare domain, a people search that surfaces the folks you
follow first, and full cross-compatibility with Vector invite links.

### Added
- Edit a community's name, description, logo, and banner.
- Create and rename channels within a community.
- Custom roles with per-permission controls (manage roles, metadata, channels,
  kick, ban, and more).
- Moderation: kick, ban, unban, and hide messages.
- Message editing in communities.
- Live typing indicators showing when someone is composing a message.
- Invite links can expire (never, 1, 7, or 30 days), carry a label, and be
  revoked.
- Owners can permanently dissolve a community.
- A people search when inviting that surfaces accounts you follow first, plus a
  paste button.

### Changed
- Redesigned Add and Invite dialogs.
- Community invite links are now fully compatible with Vector.

## [0.4.7] - 2026-06-24

A chat readability and touch-friendliness release. The per-message action
buttons (react, reply, thread, edit, pin, delete) now float in a panel above the
message instead of crowding the author's name, so long names and titles are no
longer cut off. The buttons are larger on phones and tablets, the panel only
appears on tap (and stays put until you deliberately tap an action, so you won't
fat-finger a delete), and on desktop a click no longer highlights a message.
Reaction emoji also sit properly centered in their pills.

### Changed
- Message action buttons now float in a panel above the message rather than
  inline with the author's name, and are larger and easier to tap on phones and
  tablets.

### Fixed
- A long username is no longer truncated by the author's title badge.
- On desktop, clicking a message no longer highlights it; the action panel still
  appears on hover.
- Reaction emoji are now vertically centered in their pills.

## [0.4.6] - 2026-06-23

A reliability release for chat, encrypted messages, and offline use. Encrypted
direct messages now open instantly and stay decrypted when you switch back to a
thread, filling in from the newest message down. Chat stays pinned to the
bottom as images, link previews, and reactions load in, so the view no longer
drifts upward. Your channel lists, conversations, and account names now survive
a flaky or offline connection instead of vanishing, and channels from different
servers no longer bleed into each other.

### Changed
- Direct messages open noticeably faster and reveal newest-first; revisiting a
  thread no longer re-decrypts everything from scratch.
- Account names and avatars in the account switcher load instantly from local
  storage, including when you're offline.

### Fixed
- Chat now stays anchored to the bottom while images, link previews, and
  reactions finish loading, instead of drifting up the screen.
- The message composer no longer briefly flashes a "join to send" prompt for
  members while a channel is still loading.
- Channel lists, direct-message conversations, and threads no longer disappear
  or shrink on a slow, flaky, or offline connection.
- Channels from one server no longer show up as phantom rooms on another server
  that shares the same identity.

## [0.4.5] - 2026-06-23

Messages everywhere now feel instant and your server list stops vanishing.
Group and encrypted-community messages send optimistically — they appear the
moment you hit send, the box clears right away, and you can fire off several in
a row without the app locking up. Deleting an encrypted-community message
removes it immediately. Separately, the server rail and encrypted-community
list no longer flicker out and disappear on a flaky connection.

### Changed
- Group and encrypted-community messages appear immediately on send and the
  compose box clears right away, instead of waiting for the server. You can
  send several in a row without the input locking up between them.
- Deleting a message in an encrypted community now hides it immediately.

### Fixed
- The server list (the icons on the left) no longer briefly appears and then
  disappears on a slow or flaky connection.
- The encrypted-community list and its channels no longer flicker out and
  vanish when the connection is struggling.
- A message that fails to send now shows a retry option inline instead of
  silently disappearing.
- Prevented a rare case where saving your server or community list during a
  connection hiccup could wipe it.

## [0.4.4] - 2026-06-23

Direct messages now send instantly. Your message appears the moment you hit
send and the input clears right away, so you can fire off several messages in a
row without the app freezing up while it waits. If a message can't be delivered
it's now shown clearly with a tap-to-retry option instead of silently
disappearing.

### Changed
- Sent direct messages appear immediately and the compose box clears right
  away, instead of waiting for the message to reach the server first.
- You can send several direct messages back-to-back without the input locking
  up between them.

### Fixed
- Rapid-fire direct messages no longer thrash and stall against background
  work, which previously made a burst of messages crawl out one at a time.
- A direct message that fails to send now shows a "Not delivered — tap to
  retry" prompt instead of vanishing with no explanation.

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

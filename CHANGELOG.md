# Changelog

All notable changes to Armada are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and releases are tagged
`vX.Y.Z`.

## [0.28.0] - 2026-07-15

A private direct messages release. Armada now sends and receives fully
encrypted, metadata-hiding DMs — including images and files — and raises
notifications for incoming messages on both desktop and Android. You can search
your whole DM history and jump straight to matching messages. When a person
hasn't set up private messaging, Armada tells you plainly and lets you choose
whether to fall back to older, less-private encryption rather than silently
downgrading. Profile hovercards now pick up each person's own color theme, and
desktop voice tells you how to fix a microphone that's blocked by your OS.

### Added
- Private direct messages: fully encrypted DMs that hide who you're talking to,
  with support for sending images and files
- Notifications for incoming DMs while the app is running, plus Android
  background notifications for new DMs
- Notifications when someone reacts to your message in a Concord community
- Search across your full DM history, with matching text highlighted and a
  tap-to-jump list

### Changed
- When a recipient hasn't enabled private messaging, Armada now explains the
  situation and asks you to explicitly opt in to legacy encryption instead of
  quietly using the less-private format; the privacy badge is now tap-to-open
  with plain-language detail
- DM headers are decluttered: search and options moved into an overflow menu,
  with a padlock badge on the avatar
- Profile hovercards are tinted with the person's own color theme

### Fixed
- "Skip for now" on the welcome screen is remembered, so onboarding isn't forced
  on every relaunch
- Desktop voice now guides you to the OS privacy setting when the microphone is
  blocked at the system level, instead of just failing
- Profile cards no longer briefly flip to an older version of someone's profile

## [0.27.3] - 2026-07-14

A notifications release. Armada now raises real notifications for incoming
messages, mentions, and DMs while it's running, and you can set a Discord-style
notification level per conversation — all messages, mentions only, or nothing.
This release also steadies live message delivery over long sessions, adds a
single consent prompt before decrypting a backlog of DMs on bunker/extension
signers, shows now-playing music status on profiles, and fixes a handful of
Concord community edge cases.

### Added
- Notifications for incoming messages, mentions, and DMs while the app is open
- Per-conversation notification levels — choose all messages, mentions only, or
  nothing for each channel and DM
- Now-playing music status shown on profiles and member lists

### Changed
- Opening DMs with a bunker or extension signer now asks once before decrypting
  a large backlog, instead of firing a decrypt request per message

### Fixed
- Live messages now keep streaming into the open channel over long sessions
  instead of silently stalling until a relaunch
- Newly-added Concord channels now appear right away instead of waiting for a
  first message
- Member-only channels are recovered for users migrating from Flotilla
- A Concord community is brought back when a rekey re-includes a previously
  excluded member
- A dissolved Concord community is now read-only and can be removed manually
- Joining a call with video auto-expands the call stage, with a clearer stage
  toggle; paused stage videos resume when moved back into a page slot

## [0.27.2] - 2026-07-13

A permissions and enforcement release for Concord communities. Banned
members can no longer keep editing community metadata, channels, or grants
after being removed; only members with the proper rank can revoke or demote
others (previously any member could strip anyone's role); a dissolved
community can't be refounded out from under its owner; and the per-plane
read rules and metadata size limits are now applied on read, not just on
write.

### Fixed
- Banned members' events are now dropped everywhere in a community, not
  just in chat — previously a banned member could still edit community
  metadata, channels, grants, or the guestbook, and could even rekey the
  community out from under everyone
- A community's owner dissolution now wins every race: the app no longer
  adopts a rekey epoch past the owner's dissolution, and a dissolved
  community can't be rotated
- Only members who actually outrank a role can revoke or demote it —
  previously any member could strip anyone's rank because the authority
  check passed vacuously for empty (revoke) grant editions, and a
  lower-ranked role manager could demote a grant above its station
- A moderation action that the signer lacks the authority for is now
  pre-checked before publishing, so a kick/ban-only holder no longer
  publishes a doomed grant edition
- Control-plane editions are now required to be plaintext on read and
  chat/guestbook/rekey editions encrypted on read, matching the per-plane
  seal rules; an encrypted control edition used to fold and then silently
  vanish at the next compaction
- Community and channel name (64-byte) and description (10000-byte) limits
  are now enforced when folding metadata and channel editions, not just
  when writing

## [0.27.1] - 2026-07-13

A reliability and messaging release. Sending a message in an encrypted
community now shows it immediately with a pending badge instead of swallowing
it when remote signing is slow or fails, and signing in with a remote signer
(such as Amber) no longer dies silently on Android. Login now decrypts your
recent channel history before opening — no more empty rooms while catch-up
runs — with a slim in-chat status bar that names what's still catching up.
Plus fixes for private zaps that silently failed to seal, on-chain zaps
missing in self-hosted rooms, and initial sync overwriting your settings.

### Added
- A slim in-chat sync status bar names the background catch-up in flight
  ("Syncing #general — 84 messages") and hides once the channel is caught up

### Changed
- After login, the app now decrypts your recent channel history before
  opening, so rooms are populated instead of empty while catch-up finishes

### Fixed
- Messages you send in encrypted communities now appear immediately with a
  pending badge instead of vanishing when remote signing is slow or fails; a
  failed send shows a retryable state and a "Message not sent" notice rather
  than disappearing silently
- Signing in with a remote signer (such as Amber) no longer dies silently on
  Android, and lost signer responses recover in seconds instead of hanging
  forever
- The app no longer goes blank until you restart it when a background sync
  step silently wedges; stuck history pulls and dead live updates now
  self-recover
- Initial sync no longer overwrites your synced settings across relays and
  devices when the settings read comes back empty
- Private zaps in encrypted communities now reliably seal and appear for
  everyone, even when the wallet's payment acknowledgement is slow or lost,
  and private zaps again require a connected wallet
- On-chain Bitcoin zaps now appear under the reactions row in self-hosted
  server rooms, not just in Concord communities

## [0.27.0] - 2026-07-12

Armada can now send Bitcoin to other users: Lightning zaps from a wallet you
connect in Settings, plus on-chain payments whose attribution is sealed
privately into the channel tally. Messages in Concord communities can be edited after sending. Bot
accounts show a Bot badge next to their name wherever you see them. Tapping a
thread-reply notification now opens the thread directly, and the app lands on
your actual first community after login instead of a server you didn't pick.
Plus reaction removal, safe-area padding, and Android back-gesture fixes round
out the release.

### Added
- Send Lightning zaps to other users, publicly in servers and privately in
  Concord communities, from a Lightning wallet you connect in Settings
- Send on-chain Bitcoin payments, with the zap attribution sealed privately
  into the channel tally
- Edit your own messages in Concord communities after sending
- Wallet settings to connect and manage Lightning wallets and configure Bitcoin
  payment options
- Bot accounts show a Bot badge next to their name in chat, the member list,
  profile cards, mentions, and DMs
- Your custom emoji list now syncs across your devices

### Changed
- Tapping a thread-reply notification opens the thread panel directly, instead
  of just the channel
- After login, the app lands on the first item in your arranged community rail
  — not always the first server
- Opening a server's home page no longer auto-redirects into a channel

### Fixed
- Tapping a reaction you already added removes it instead of doing nothing
- Notifications for the channel or thread you're currently viewing are now
  suppressed
- Thread unread highlights clear when you open the thread from the chat timeline
- Image lightboxes close on the Android back gesture instead of navigating away
- Content in mentions, threads, DMs, and settings no longer scrolls under the
  home indicator or nav bar
- Replies whose original message isn't loaded are reachable from the Threads tab
  instead of cluttering the timeline
- Relay authentication no longer drops mid-session when a relay throttles a
  challenge or closes a subscription, which could stall live updates on desktop
  and web until restart

## [0.26.0] - 2026-07-11

Your account now stays in sync across devices automatically — joins, mutes,
follows, and settings made on one device reach the others without a manual
refetch. You can now delete your account right from Settings, with a guided
checklist of what gets removed from the network. A built-in changelog page
replaces the old "what's new" guesswork: a toast lets you know when an update
landed and links to the full release notes, now browsable in-app. Privacy
Policy and Terms of Service pages are reachable from the settings footer.
Several smaller fixes round out the release: the swipe-to-reveal gesture is
consistent again, thread state no longer leaks when switching between Concord
communities, and message context menus flip upward instead of dropping into
the composer.

### Added
- Cross-device sync: your follow list, mute list, server and channel
  memberships, Concord communities, relay lists, and app settings now stay
  continuously in sync across all your devices
- Delete account from Settings, with a guided checklist of what gets removed
- In-app changelog page with full release notes, linked from the Settings
  version footer
- Toast notification when a new version is available
- Privacy Policy and Terms of Service pages, linked from the Settings footer

### Fixed
- Swipe-to-reveal gesture is consistent across all list rows again
- Thread panel state no longer leaks when switching between Concord communities
- Message context menus flip upward instead of dropping into the composer
- Concord communities now populate correctly on a fresh login
- Back button on Settings sub-pages (changelog, terms, privacy) no longer
  loops back to the page you came from

## [0.25.4] - 2026-07-10

Every channel can now host a call — the text/voice split is gone, so you start
or join a call right from a channel's list row or its chat header. The Mentions
and Threads tabs now clear their unread badges the moment you open them, no more
per-item chasing. Bluetooth mesh got steadier on Android: your mesh identity
survives a device restore, and turning mesh off and back on no longer leaves it
stuck. Rounding it out are fixes for overflowing quoted text on narrow screens,
an attachment preview that appears the instant you pick a file, and big
behind-the-scenes speedups that cut battery and CPU use during long sessions.

### Changed
- Every channel is now callable: the separate text/voice channel types are gone,
  and you start or join a call from the channel's list row or chat header
- Opening the Mentions or Threads tab now marks everything in it as read

### Fixed
- Bluetooth mesh: your mesh identity is now restored after an Android backup
  restore, and toggling mesh off then on no longer leaves it unable to restart
- Long quoted text in replies and embedded notes no longer overflows on narrow
  screens
- The attachment preview now shows immediately when you pick a file, instead of
  only after it finishes processing
- Tooltips on the server rail no longer stick on touch devices
- Faster and lighter during long sessions: heavy encryption work is now cached
  and scoped per community, reducing background CPU and battery drain

## [0.25.3] - 2026-07-09

A quieter, more respectful release: removing a relay in Settings now actually
disconnects it instead of silently reconnecting to a built-in one, and the app
does far less needless background polling — no more constant refetching of
member statuses or duplicate catch-up requests on idle channels, and polls now
pause entirely while the app is in the background. That means less battery and
data use when you're not actively chatting.

### Changed
- Greatly reduced background network activity on idle channels, and paused it
  entirely while the app is in the background, for lower battery and data use

### Fixed
- Removing a relay in Settings now takes effect instead of reconnecting to a
  built-in default

## [0.25.2] - 2026-07-09

Chat images now open in a cinematic gallery: swipe between photos, pinch or
double-tap to zoom and pan, and download or open the original, with images
blurring up smoothly as they load. Voice notes now play through automatically,
rolling to the next one when the current clip ends. The message toolbar's Reply
and Quote actions have been reordered and relabeled for clarity, and a mute
indicator now shows in the sidebar voice roster while you're in a call.

### Added
- Cinematic image gallery in chat: horizontal swipe between images, pinch, wheel,
  and double-tap zoom and pan, a download/open-original button, and blurred
  placeholders that sharpen as each image loads
- Voice notes auto-play the next clip when one finishes
- Mute indicator in the sidebar voice roster while you're in a call

### Changed
- Reworked the message Reply and Quote actions: clearer labels, icons, and order

### Fixed
- Emoji picker no longer clips at the edges of reaction and status popovers

## [0.25.1] - 2026-07-09

Fixes an Android bug where community channels would silently stop loading after
the app was backgrounded or the screen turned off, leaving rooms blank until the
app was fully closed and reopened. Camera-off participants in a call now show a
softly blurred version of their avatar behind their tile instead of a flat
placeholder.

### Fixed
- Android: community channels no longer go blank after backgrounding the app or
  turning the screen off and returning — history now catches up within a couple
  seconds instead of requiring a full restart

### Changed
- Call tiles for participants with their camera off now display a blurred avatar
  backdrop instead of a plain placeholder

## [0.25.0] - 2026-07-09

New members now get a guided, full-page setup: generate and save a key, set up a
profile, and create or join a community, all in one flow. The community sidebar
header is reworked into a cleaner layout with a Discord-style menu that expands
inline for settings, invites, roles, and more. Cold-starting the Android app now
shows an animated Armada crest that holds until the app is ready instead of a
blank screen. This release also fixes community channels that could load blank
or slowly, or briefly flash the wrong channel's messages when switching, and
sharpens mobile layout on notched and landscape screens.

### Added
- Full-page onboarding for new members: a step-by-step wizard to generate a key,
  save it, set up your profile, and create or join a community, with every step
  after saving your key skippable
- Mesh chat on/off toggle in the channel-list sidebar, so you can turn mesh on or
  off without first opening a chat

### Changed
- Reworked community/server sidebar header: the name is now a menu that expands
  inline for settings, invite, create channel, roles, mute, leave, and delete;
  the community banner and icon layout are cleaned up
- Android cold start now shows an animated Armada crest that stays on screen
  until the app has painted, replacing the blank frame on launch
- The profile editor hides its edit pencils on touch devices for a cleaner look
- The platform relay is no longer pinned automatically; join it like any other
  community via its invite or server link

### Fixed
- Community channels that could load blank until an app restart, load slowly, or
  briefly flash the previous channel's messages when switching now load promptly
  and correctly, including channels with older history
- The Mentions view now surfaces mentions buried deep in a channel's history, not
  just recent ones
- Mobile safe-area handling on notched and landscape screens: content no longer
  slides under a side notch, the composer clears tall navigation bars, and the
  message placeholder stays put after rotating
- Status-bar icons over a community banner stay legible with a subtle scrim

## [0.24.0] - 2026-07-08

Replying in community chat now works the way you'd expect. Alongside the
existing "reply in thread", you can now send a normal inline reply that shows up
right in the timeline with a "replying to" bar, quoting the original message
(and a thumbnail if it had an image). This release also fixes replies and other
messages that could silently fail to send — especially on mobile after the app
had been backgrounded or the network changed — so what you send actually
arrives.

### Added
- Inline replies in community chat: reply to a message and your reply appears
  in the timeline with a bar quoting the original, distinct from replying in a
  thread

### Fixed
- Messages that could silently fail to send after a dropped or stale connection
  (common on mobile) now reconnect and deliver, and previously stuck messages
  are marked sent once they go through

## [0.23.0] - 2026-07-08

Communities gain two new ways to keep up with what matters to you. A Mentions
view collects every message that @-mentions you across the community's channels
in one place, and a Threads view lists the threads you're part of, newest reply
first. Both light up when there's something new, and tapping any entry jumps
straight to the message in its channel.

### Added
- Mentions view in the community sidebar that gathers every message mentioning
  you across all channels; the nav item highlights when you have a new mention,
  and tapping a mention jumps to it in its channel
- Threads view in the community sidebar listing threads you've taken part in,
  ordered by most recent reply, with unread highlighting and a tap to open the
  thread in its channel

## [0.22.0] - 2026-07-08

You can now send longer messages, and very long messages no longer flood the
timeline. The chat character limit is raised to 5,000, and messages that run
long are collapsed by default with a "Read more" toggle to expand them.

### Added
- "Read more" toggle that collapses long messages so they don't dominate the
  timeline, with a tap to expand and collapse again

### Changed
- Raised the chat message character limit from 2,000 to 5,000

## [0.21.1] - 2026-07-08

A reliability release focused on the Android app. Invite and share links now
point at the real site instead of an internal address, so they open correctly
for other people. Connections recover cleanly after dropping — messaging,
notifications, and voice no longer stay broken until you restart the app — and
joining a community that can't be reached now gives a clear error instead of
silently failing.

### Fixed
- Invite and share links (community invites, server/channel links, and signer
  pairing) now use the public site address, so they work when opened by others
- Messaging and notifications recover automatically after a connection drops,
  instead of staying broken until the app is restarted
- Joining or previewing a community that can't be reached now shows a clear
  error, and creating an invite over an unreachable connection warns you
- Signing in with a remote signer no longer times out prematurely on relays
  that require authentication
- More reliable message and notification delivery on relays with stricter limits



Messaging sync is overhauled so chat stays consistent everywhere. Messages now
arrive live in every channel of a server — not just the one you have open — and
unread badges light immediately across the sidebar, server rail, and app icon.
Servers that looked empty now load their channels reliably, time spent offline
is caught up on reconnect, and rooms no longer get stuck showing only a single
message. Unread badges also come to voice/text servers that previously had none.

### Added
- Unread badges for Concord (V1) servers, shown in the channel list, server rail, and folders

### Changed
- All chat now syncs through a single unified pipeline, so timelines and unread counts stay in agreement across every view
- Messages sent to any channel arrive and badge live, without needing to open that channel first
- Time spent offline is replayed on reconnect (up to 7 days), so you don't miss messages

### Fixed
- Servers that appeared empty now load their channels and message history
- Unread badges no longer go stale when messages sync in the background
- Rooms that received a single message no longer get stuck hiding the rest of their history
- No longer need to resync a community after logging in
- Empty timelines show a loading state instead of briefly flashing "no messages yet"

## [0.20.0] - 2026-07-08

This release overhauls mobile navigation and polish: swipe-to-dismiss on image
lightboxes, smoother community/channel switching on mobile, a redesigned DM
sidebar that matches the community layout, improved iOS PWA behaviour, and
a richer thread panel with context menus, message deletion, and collapsing of
consecutive replies. Voice calls gain per-participant volume controls.

### Added
- Swipe down to dismiss image lightboxes (banner/avatar previews and in-chat images)
- Per-participant volume control in the mobile call's audio settings
- Thread panel: right-click context menu with Copy link, Delete message, and View event JSON
- Thread panel: consecutive replies from the same author now collapse into a compact view, matching the main timeline

### Changed
- DM list sidebar redesigned to match the community layout (Messages sub-header, divider, consistent header height)
- DM and Mesh rail buttons now show the same active indicator blade as communities
- Mobile: tapping a community or server now lands on the channel list instead of the last-viewed channel
- Redirects after login now go to synced servers rather than the join screen
- Community banner on mobile is now a header background instead of a stacked block

### Fixed
- Mobile swipe glitches when switching communities and servers
- Channel list and sidebar header no longer flash or shift when switching communities
- iOS standalone PWA: fixed bottom gap and scroll-lock pinned correctly to `<html>`
- iOS theater-mode call: status bar area now clears correctly when closing the call stage
- Kick in voice calls now takes effect immediately for active participants
- Service worker cache now rotates per deploy, preventing stale assets after updates
- Community creation now snapshots the correct set of relay hints

## [0.19.3] - 2026-07-07

GIF search now uses a new provider for more reliable results, and signing in
with a remote signer (such as Amber) works against Armada's own relay, so you no
longer need a separate rendezvous relay to log in that way.

### Changed
- GIF search now uses GIFverse for more reliable results

### Fixed
- Signing in with a remote signer (e.g. Amber) now works using Armada's relay as
  the rendezvous point

## [0.19.2] - 2026-07-07

Small quality-of-life update: mute a community or channel straight from its
header menu (handy on touch screens), plus two Android fixes — text-selection
controls no longer render as black boxes, and a one-time prompt helps you
exempt Armada from battery optimization so notifications keep working.

### Added
- Mute options in the channel and community header ⋮ menus, so muting no
  longer requires a right-click
- Android app: a one-time prompt to allow background usage when battery
  optimization would otherwise cut off notifications

### Fixed
- Android app: black boxes no longer appear behind the text-selection toolbar
  and selection handles

## [0.19.1] - 2026-07-07

Fixes voice and video calls on the Android app and the desktop app: both now
properly request microphone and camera access, so calls no longer fail with a
silently denied mic.

### Fixed
- Android app: microphone and camera permissions are now requested, so voice
  and video calls work instead of the mic being silently denied
- Desktop app: microphone and camera access is granted for calls (with the
  required macOS usage prompts), and other permission requests are denied
  unless they come from Armada itself

## [0.19.0] - 2026-07-07

Organize your community rail Discord-style: drop one community onto another to
create a folder, and long-press any icon to pick it up and reorder — folders,
order and all synced across your devices. Notifications get personal too:
right-click a community or channel to mute it everywhere, including push
notifications. Plus @mentions in thread replies, a redesigned status dialog
with an emoji picker, and a Voice server setting for diagnosing call
connectivity.

### Added
- Folders on the community rail: drop one community onto another to group
  them, drag in and out to organize, and right-click a folder to rename or
  remove it; collapsed folders show a mini icon grid with unread indicators
- Reorder the rail by long-pressing an icon to pick it up, with a live
  preview of where it will land; the layout syncs across your devices
- Mute a community or channel from its right-click menu — muted places stop
  notifying (including push notifications), stop bolding, and stop counting
  toward badges, while mentions still get through; mutes sync across devices
- @mentions in thread replies
- "Voice server" setting with a live reachability check, so you can see and
  change the server voice calls run through

### Changed
- The status dialog is now a proper modal with a full emoji picker for the
  status emoji

### Fixed
- Joining a voice channel right after opening a community no longer fails
  with a spurious "no voice server" error

## [0.18.0] - 2026-07-07

Voice calls arrive in newer encrypted communities, with verified participant
identities. Calls also get quality-of-life upgrades: right-click a participant
to adjust their volume or mute them, the call UI stays alive while you browse
other channels, and the sidebar shows live speaking indicators. Plus fixes for
encrypted-community messages that notified but never appeared, and a bug that
could make your microphone transmit silence.

### Added
- Voice calls in newer encrypted communities, with per-participant identity
  verification
- Right-click a participant — on their call tile or in the sidebar voice
  roster — to adjust their volume or mute them for yourself; per-user volume
  now works on mobile too
- Voice memos in encrypted communities and direct messages
- New "Media servers" settings section to manage where your uploads are stored

### Changed
- The call view and call bar stay alive when you navigate to other channels
- The participant list for a call you're in now comes straight from the live
  call connection, so it no longer shows ghost or missing participants
- The sidebar voice roster shows live speaking rings while you're in that
  channel's call, and the call bar no longer duplicates the participant list
- Direct messages are now always limited to people you follow, and messages
  from strangers are never fetched or notified
- Removing a server now stays removed across your devices

### Fixed
- Encrypted-community messages that triggered a notification but never
  appeared in the channel now show up reliably, including after being offline
  for a while
- Encrypted video and audio attachments now play instead of silently failing
- The microphone no longer transmits silence in calls when background-noise
  removal is enabled
- Uploads with unusual file extensions now play correctly
- Unread indicators on the community rail now clear as soon as you read the
  channel, without needing a reload
- Speaking indicators update more promptly

### Removed
- The experimental voice feature in older encrypted communities (superseded
  by the new call system)

## [0.17.6] - 2026-07-06

Adds unread tracking to Concord v2 channels, and gives the active channel a
clearer highlight everywhere.

### Added
- Concord v2 channels now show unread indicators (bright/bold text, and an
  '@' pill for mentions) on both the channel list and community icon

### Changed
- The active channel now gets a clearer filled highlight, consistent across
  NIP-29 rooms and Concord v1/v2
- Improved text contrast on colored backgrounds (e.g. the active-channel
  highlight) so text stays readable regardless of the color

## [0.17.5] - 2026-07-06

Armada links now open straight into the Android app: tapping an
https://armada.buzz invite or shared channel link lands you in the right room
instead of the browser. Also fixes a background notification bug that could
quietly drain the battery overnight on flaky connections.

### Added
- armada.buzz links (invites, shared channels) now open directly in the
  Android app

### Fixed
- Background notifications no longer drain the battery by reconnecting in a
  tight loop when a relay or network keeps dropping the connection

## [0.17.4] - 2026-07-06

Fixes member promotion in newer communities: "Make moderator" was silently
doing nothing, and "Make admin" published correctly but the promoter often
didn't see the change take effect right away.

### Fixed
- "Make moderator" now actually grants moderator permissions instead of
  silently doing nothing
- Promoting or demoting a member now shows up immediately for the person who
  made the change, and failures are now reported instead of failing silently

## [0.17.3] - 2026-07-06

Polishes invites and a few everyday interactions. Inviting someone is now
simpler: the invite dialog leads with a single action and tucks the extra
options away, and direct invites to a known contact are delivered more
reliably. Copying an invite link now works everywhere, including in the mobile
and desktop apps, with clear per-link feedback. Logging in is a cleaner
single-step dialog, and typing indicators get a friendlier Signal-style look.

### Changed
- The invite dialog now leads with a single primary action and keeps advanced
  options behind a disclosure, with an info popover explaining the choices
- Logging in is now a streamlined single-input dialog
- Typing indicators now show a Signal-style avatar stack with a pulsing-dot pill

### Fixed
- Copying invite links now works in the mobile and desktop apps (not just the
  browser), with clear feedback on the link you copied
- Direct invites to a known contact are delivered more reliably

## [0.17.2] - 2026-07-06

Focuses on making communities load and feel faster: chat history, invites, and
community details are now cached locally after they're first decrypted, so
reopening a community is quicker and puts less strain on remote signers. Also
fixes a bug where switching communities could briefly show the previous
community's messages while the new one was still loading.

### Changed
- Chat history, invites, and community details are now cached locally after
  decrypting, so reopening a community loads faster and is easier on remote
  signers
- Community details (members, channels, banned users) now sync in the
  background for all your communities, not just the one you have open

### Fixed
- Switching communities no longer briefly shows the previous community's
  messages while the new one is still loading

## [0.17.1] - 2026-07-05

Your settings now follow you across devices more completely, and a few rough
edges are smoothed out: opening a community on mobile is a single clean slide
instead of a jumpy double transition, the community sidebar scrolls properly by
touch again, and links at the end of a message no longer swallow the space
before them.

### Changed
- More of your setup now syncs across devices, including your community and
  sidebar order, added relays, and the last channel you had open in each
  community

### Fixed
- Opening a community on mobile now transitions smoothly in one step instead of
  visibly jumping through the channel list first
- The community sidebar can be scrolled by touch again on mobile
- A link at the end of a message no longer glues itself to the preceding word

## [0.17.0] - 2026-07-05

Brings Slack-style threads to every conversation: reply to any message and the
whole exchange folds into a tidy thread you can open on the side, with a badge
showing who's taken part. Communities gain an info dialog with a click-to-zoom
banner and icon, the sidebar rail is now one list you can drag to reorder however
you like, and mobile chat headers show the community's avatar and name. You'll
also get native notifications for the newest generation of communities, typing
`#channel` jumps straight to that channel, and chat history loads faster and
deeper.

### Added
- Slack-style threads: nested replies fold into a side panel across all
  conversations, with a badge showing the participants who've replied
- Community info dialog with a click-to-zoom banner and icon, merged with
  community settings into one view
- Native notifications for the newest generation of communities
- Community avatar and name in the mobile chat header

### Changed
- The sidebar community rail is now a single list you can drag to reorder freely
- Typing `#channel` now jumps to that channel in the current community
- Chat history loads faster and backfills deeper when opening a conversation

## [0.16.0] - 2026-07-05

Introduces the next generation of Armada's private community protocol as the
new standard for communities, built for stronger privacy and spam resistance.
New communities now use it by default, and existing communities remain fully
usable alongside it. This release also adds a safety net that keeps the app on
its feet if a screen hits an error, and fixes a couple of stubborn glitches
around leaving communities and removing servers.

### Added
- New private community protocol, now the default when creating communities,
  with joins and invites that work everywhere
- App-wide error screen that recovers gracefully instead of showing a blank
  page when something goes wrong

### Fixed
- Leaving a community that failed to load now works and reports any problem
  instead of doing nothing
- The "Remove server" option no longer disappears for servers you added, and
  removed servers no longer reappear in the sidebar

## [0.15.4] - 2026-07-03

Cleans up the Concord interface by removing the "end-to-end encrypted" badges,
shields, and labels that appeared throughout voice and community screens. The
extra chrome was visual noise; the interface is now quieter without changing how
anything works.

### Changed
- Removed the encryption shields and "end-to-end encrypted" labels from voice
  call bars, the join-voice button, community sidebars and icons, voice
  settings, and the About page

## [0.15.3] - 2026-07-02

Makes experimental CORD communities actually work across members: messages sent
by one member are now visible to everyone else (previously each member only saw
their own). CORD communities now gather on the protocol's standard relay set
and authenticate themselves to relays that gate encrypted-message reads — on
web, desktop, and in Android background notifications. Also updates the CORD
message envelope to the latest protocol draft.

### Fixed
- Messages in CORD communities are now visible to other members; previously
  members could publish but never read each other, so every conversation
  looked one-sided
- CORD communities connect to the protocol's standard relays; existing
  communities pick them up automatically
- Android background notifications for CORD communities now work on relays
  that require authentication, even when the app hasn't been opened since boot

### Changed
- Updated the CORD message envelope to the latest protocol draft; experimental
  messages sent with earlier builds are no longer readable

## [0.15.2] - 2026-07-02

Adds experimental support for CORD, the next generation of Armada's private
community protocol, built for stronger privacy and spam resistance. Invites to
CORD communities can be accepted everywhere; creating one is an opt-in preview
in development builds while the protocol stabilizes. Messages in CORD
communities also trigger native Android notifications.

### Added
- Experimental CORD community protocol: joining CORD community invites works
  everywhere, and creating CORD communities is available as a preview in
  development builds
- Native Android notifications for messages in CORD communities

## [0.15.1] - 2026-07-02

Fixes a nasty cache bug where messages and member lists from one room could
leak into another after switching rooms — most visibly in Concord communities,
where another channel's messages could appear (and stick) in the wrong channel.
Affected rooms clean themselves up automatically on the next visit.

### Fixed
- Switching between rooms could save one room's messages into another room's
  local cache, making the wrong messages (and their senders in the member list)
  show up there on later visits. Already-polluted caches self-heal.
- Switching between communities could briefly show — or fall back to — the
  previous community's member list, name, and moderation state, which could
  wrongly hide messages.

## [0.15.0] - 2026-07-02

Armada is now installable as an app. Add it to your home screen or desktop for a
full-screen, offline-capable experience, and share links and images straight
into a chat from other apps. This release also adds "View on Ditto" shortcuts
throughout, so you can jump to the richer social view of any post, profile, or
hashtag on ditto.pub.

### Added
- Install Armada as an app (PWA): add it to your home screen or desktop for a
  standalone, full-screen window, with offline caching and faster loads.
- Share into Armada: send links and images from other apps directly into a chat.
- "View on Ditto" throughout: embedded posts, the message menu, profiles, and
  the DM header link out to the full post/profile on ditto.pub.
- Hashtags in messages and events are now tappable and open the hashtag feed on
  ditto.pub.

### Changed
- Embedded posts are rendered as cleaner, Ditto-style note cards.
- Links to posts and profiles that Armada doesn't expand now open on ditto.pub.

## [0.14.0] - 2026-07-01

A big Discord-style chat refresh. The interface now feels more familiar if
you're coming from Discord: a quick switcher (Ctrl/Cmd+K) to jump anywhere,
date separators and an unread "New" divider in the message timeline, live voice
participants shown directly in the sidebar under their channel, markdown code
blocks in messages, and a cleaner collapsible settings page.

### Added
- Quick switcher (Ctrl/Cmd+K): fuzzy-search servers, channels, DMs, and
  settings from a palette. Alt+Up/Down hops between channels in the current
  server.
- Date separators in the message timeline group messages by day, with "Today"
  and "Yesterday" labels.
- Unread "New" divider marks where you left off in a channel.
- Voice participants are shown as an indented roster under their channel in the
  sidebar, so you can see who's in a call at a glance.
- Markdown code blocks and inline code in messages are now rendered with syntax
  highlighting.

### Changed
- Settings page is reorganized into collapsible sections, making it easier to
  find what you're looking for.
- Member list and channel sidebar have been polished for a more Discord-like
  feel.

## [0.13.2] - 2026-07-01

Sharper notification taps: the message you tapped now shows up in the very
first frame instead of popping in a moment after the room opens.

### Fixed
- Opening a chat from a notification no longer shows the room briefly without
  the new message — it's there on the first paint.
- Navigating to a screen you haven't visited yet this session no longer pauses
  on the splash while it loads.

## [0.13.1] - 2026-07-01

Faster and more dependable. The app now opens straight into your chats — the
last messages in every room appear instantly instead of loading spinners, even
when launched from a notification tap. On Android, background notifications now
survive reboots and app updates, and Settings warns you (with a one-tap fix)
when battery optimization would silence them. Bluetooth mesh chat is now
opt-in, so nothing Bluetooth-related happens until you turn it on.

### Changed
- The app opens instantly to your recent messages instead of loading spinners,
  including when launched from a notification tap.
- A branded splash screen replaces the blank frame while the app starts up.
- Bluetooth mesh chat is now opt-in: it stays completely off (no permission
  prompts, no persistent notification) until you enable it, and you can turn
  it off from the mesh screen.
- The mesh icon only appears on devices that can actually use it, so web and
  desktop no longer show a dead-end Bluetooth screen.

### Fixed
- Background notifications on Android resume automatically after a reboot or
  app update instead of staying off until you reopen the app.
- Notification settings now warn when battery optimization would stop
  background notifications, with a one-tap button to fix it.

## [0.13.0] - 2026-06-30

Armada now works with no internet at all. On Android, a new Bluetooth mesh lets
you chat with people nearby — your phones relay messages to each other directly,
so you can talk in channels or one-on-one even with no signal and no Wi-Fi. It's
compatible with bitchat, so Armada and bitchat users on the same mesh see each
other. You can pick a nickname or stay incognito, and @-mention nearby people
and run quick commands like /me right from the mesh composer. Signing up no
longer needs a connection either: you can create your account offline, and
anything you send while offline is queued and sent automatically once you're
back online.

### Added
- Bluetooth mesh chat on Android: talk to nearby people with no internet, in
  channels or direct messages. Compatible with bitchat.
- Choose a nickname or stay incognito on the mesh, with a colored name and a
  tappable profile popover to message or mention a peer.
- @-mentions and slash commands (like /me and /shrug) in the mesh composer.
- A "Nearby" roster and in-chat members toggle show who's currently reachable
  over the mesh.
- Offline signup: create your account without a connection.

### Changed
- Messages you send while offline are queued and sent automatically when you
  reconnect.

## [0.12.0] - 2026-06-30

The Android app now feels like a real app instead of a website in a box. The
keyboard pushes the message box up instead of covering it, buttons buzz when you
tap them, sharing an invite opens the system share sheet, and the status bar
matches your theme. Tapping is crisper — no more grey flashes, accidental text
selection, or rubber-band bounce — and touch targets, headers, and the server
rail are sized for fingers. On small phones, the less-used channel actions tuck
themselves into the channel menu so the channel name always has room.

### Added
- Buttons and toggles give haptic feedback on tap.
- Sharing an invite opens the native share sheet.

### Changed
- The on-screen keyboard now pushes the message box up above it instead of
  covering it.
- The status bar tint follows the app theme.
- Larger, finger-friendly headers, action buttons, and inputs on touch devices;
  the server rail is slimmer on phones.
- Controls that only appeared on hover (member actions, edit buttons, and more)
  now show on touch too.
- On narrow screens the channel header tucks the pins and events actions into
  the channel menu when there isn't room for everything.

### Fixed
- No more grey tap-flash, accidental long-press text selection, or whole-page
  rubber-band scrolling in the app.
- The whole app can no longer be pinch-zoomed like a web page.

## [0.11.0] - 2026-06-30

Encrypted communities now feel like the rest of chat. You can @-mention people
right from the composer, run quick slash commands like /me and /shrug, and see
who's typing by name. The channel name shows in the message box, messages send
instantly without a spinner, and the emoji picker sits neatly against the
composer.

### Added
- Mention people with `@` in encrypted-community channels, picking from members
  and recent participants.
- Slash commands in encrypted communities — `/me`, `/shrug`, `/tableflip`,
  `/unflip`, `/slap`, and `/mention`.

### Changed
- The typing indicator in encrypted communities now names who's typing
  (e.g. "Alice and Bob are typing…") instead of a generic "Someone".
- The message box shows the channel name (e.g. "Message #general") instead of a
  generic "(encrypted)" hint.
- Messages in encrypted communities send instantly, without a sending spinner;
  a failed send still offers a retry.
- The emoji shortcode menu hugs the message box for a short list instead of
  floating away from it.

## [0.10.0] - 2026-06-30

Notifications now open the right place instantly. Tapping a message notification
jumps straight to that conversation and the message is already on screen — no
waiting for the chat to catch up — even when the app was fully closed. Encrypted
communities get the same instant arrival. There's also more to do inside chat:
watch YouTube together and run little in-chat apps, with clearer voice thanks to
background-noise removal.

### Added
- Watch YouTube videos together in sync, and run lightweight in-chat apps,
  right inside a channel.
- Background-noise removal for voice calls, with a toggle in settings.

### Changed
- Tapping a notification opens the exact conversation it's about and shows the
  message immediately, instead of reloading the app and landing on the wrong or
  default room — including after the app has been closed.
- Encrypted community messages a notification was about now appear the instant
  the channel opens.
- Encrypted communities are faster to open and load.

## [0.9.2] - 2026-06-28

Direct messages get a real workout: search within a conversation, mute someone,
and a smoother way to start a new chat — plus steadier delivery after the app
has been backgrounded. Replies are also clearer everywhere: the "replying to"
hint shows who you're replying to and a preview of their message, and tapping it
jumps straight to the original (with a gentle highlight), in encrypted
communities too.

### Added
- Search within a direct-message conversation from the thread header.
- Mute a person from a direct-message conversation to hide it and stop seeing
  their messages.
- The reply hint above a message now previews the message being replied to, and
  clicking it scrolls to and highlights the original — including in encrypted
  communities.
- Visiting an invite link now adds that server to your rail.

### Changed
- Starting a new direct message and the conversation list are reworked for a
  smoother, clearer flow.
- Direct messages now render consistently with group and community chat.

### Fixed
- Direct messages keep arriving after the app has been in the background,
  catching up the moment you return or reconnect, and a message that arrived via
  notification just before opening the thread no longer goes missing.

## [0.9.1] - 2026-06-27

Chat is faster and steadier, especially on Android. Opening a channel no longer
stalls or flashes a half-empty timeline before history appears, new messages
arrive promptly even after the app has been backgrounded, and tapping a message
notification jumps you straight to that channel with the message already on
screen. The Android back gesture now steps back through the app the way you'd
expect.

### Changed
- Tapping a message notification now opens the exact channel it came from, with
  the message already loaded, instead of dropping you on the community.
- The Android back gesture and button now reveal the channel list from a
  conversation and step back through the app, rather than navigating away
  unexpectedly.

### Fixed
- Opening a channel is much faster and no longer stalls for several seconds or
  flashes a single message followed by a blank gap before history loads.
- New messages now keep arriving reliably after the app has been in the
  background, catching up the moment you return or reconnect.
- New messages in busy communities no longer stop appearing once a channel
  accumulates lots of reactions.
- Switching channels keeps the previous conversation on screen until the next
  one loads instead of flashing a loading skeleton.
- Connecting to sign-in-required relays with a remote signer is more reliable
  and no longer gets stuck retrying, so those rooms receive messages.

## [0.9.0] - 2026-06-26

Navigating channels on mobile now feels like Discord: swipe from the left edge
to reveal the channel list and swipe back (or tap a channel) to return, and
Armada reopens you in the last channel you were reading instead of a list.
One-to-one voice calls now work out of the box, Android groups a busy room's
messages into a single notification with a firmer buzz, and reopening encrypted
communities is more reliable.

### Added
- Swipe navigation on phones: drag from the left edge to reveal the channel
  list and drag back or tap a channel to slide into the conversation, on
  servers, communities, and direct messages.
- Armada remembers the last channel you had open in each server and community
  and reopens it on return, instead of dropping you on the channel list.

### Changed
- Android now bundles all the messages from one conversation into a single
  notification (showing the sender's name and avatar) instead of a separate
  notification per message, and gives new messages a stronger buzz.
- The mobile call bar is now a compact single row that no longer covers the
  message box or leaves a gap above it.

### Fixed
- One-to-one voice calls now work out of the box, falling back to a voice-capable
  relay when your own relays don't support calls.
- Community icons no longer flicker to a blank placeholder when reloading.
- New messages no longer briefly go missing when first opening a server channel
  (including when opening one by tapping a notification).
- You're no longer wrongly shown a "Join channel" banner in a channel you've
  already joined when reopening the app.
- Reopening the app with a remote signer no longer briefly shows zero
  communities or re-prompts you with invites to communities you've already
  joined.

## [0.8.3] - 2026-06-26

Encrypted communities load and scroll much faster, with reactions and images
that just work, and message notifications now arrive by default.

### Changed
- Message notifications for communities are on by default, so you're notified of
  new messages unless you turn them off in settings.

### Fixed
- Images and other attachments sent in encrypted communities now display
  correctly for everyone, both in the message and in the composer preview before
  you send.
- Opening and scrolling encrypted communities is much faster: the channel no
  longer stalls while loading long histories, and reactions now appear together
  with the messages instead of lagging behind.

## [0.8.2] - 2026-06-25

Notifications for encrypted communities now show who sent the message and a
preview of it, alongside the community and channel it came from. There's also a
new About page explaining the two ways to talk in Armada and what stays private.

### Added
- An About page that explains the two ways to talk — running your own server or
  decentralized encrypted chat — and what each keeps private. Reachable from
  Settings and the welcome screen.

### Changed
- Notifications for encrypted communities now show the sender's name and a
  preview of the message, along with the community and channel it came from,
  instead of a generic "new message" notice.

## [0.8.1] - 2026-06-25

Voice calls now work on the Android and desktop apps, the encrypted-community
message actions work on touch, and a couple of mobile layout glitches are gone.

### Fixed
- Voice call buttons now appear in the app on Android and desktop, not just the
  web client — group, direct-message, and encrypted-community calls can all be
  started from the native apps.
- Message actions (react, reply, delete) now work in encrypted communities when
  tapping on a touch screen.
- The close button on the fullscreen image viewer no longer hides behind the
  status bar on Android.
- The Settings header now matches the rest of the app's headers.

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

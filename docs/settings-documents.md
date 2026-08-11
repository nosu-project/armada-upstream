# Settings documents (NIP-78)

Armada's private, cross-device settings live in **six** NIP-78 documents —
kind 30078, NIP-44-encrypted to self, named `${APP_ID}/<name>`.

| `d` tag | Contents | Written when | Merge |
|---|---|---|---|
| `armada/metadata` | theme, custom theme, relay toggles, `appRelays`, `communityRelays`, voice-server preference, DM typing indicators, DM requests, Discover scope, zap defaults, Account Standing nag | a preference changes | wholesale |
| `armada/rail` | `railLayout` | every rail drag | wholesale |
| `armada/read-state` | `readState` | every channel view (4 s debounce) | max per key |
| `armada/notifications` | `notifLevels`, `mutedCommunities`, `mutedChannels` | a conversation is muted/tuned | wholesale |
| `armada/dms` | `dmProtocol`, `pinnedDms`, `closedDms`, `acceptedDms`, `startedDms` | a DM is pinned, closed, accepted, opened | wholesale |
| `armada/reactions` | `frequentReactions` | every reaction (10 s debounce) | max count / most recent |

The catalogue is `src/lib/settingsDocs.ts`; the schemas are in
`src/lib/schemas.ts`; the AppConfig key lists are in `src/contexts/AppContext.ts`
(`METADATA_/RAIL_/NOTIF_/DM_CONFIG_KEYS`); the read/write hook is
`src/hooks/useSettingsDoc.ts`.

## Why six and not one

A kind-30078 event is **replaceable**. Everything sharing one `d` tag is
re-serialized, re-encrypted, re-signed and re-published every time any single
field changes. With one document that meant:

- **Three writers racing one coordinate.** The config publish (800 ms), the
  read-state flush (4 s) and the reaction table (10 s) each did
  read-store → merge → sign → publish against the same event. Two landing
  inside one store-read window and the later one silently reverted the earlier.
- **An unbounded map dragged along with everything else.** `readState` has an
  entry per channel, DM, thread and mention scope the user has ever opened, and
  is never pruned. Changing the theme rewrote all of it.
- **One corrupt or undecryptable document losing everything.**

The split is by **write pattern, not by topic**. The rail has its own document
because a drag rewrites it, not because it is conceptually separate. Anything
that grows without bound or is written on a hot path gets its own; bounded
preferences that change when a human clicks something stay in `metadata`.

The cost is bounded: the standing REQ is still **one** filter with six `#d`
values (`NostrSync.tsx`), so there are no extra subscriptions — six decrypts on
boot instead of one.

## `APP_ID`

`src/lib/platform.ts`:

```ts
export const APP_ID: string = import.meta.env.VITE_APP_ID || "armada";
```

`${APP_ID}/<name>` is what lets a fork or a custom build own its own documents
on the same identity without colliding — and, read the other way, is what keeps
Armada's documents out of every other NIP-78 client's way on a kind the whole
ecosystem shares.

Because the default is `"armada"`, every `d` tag is byte-identical to what
shipped before it was parameterized. **Don't change the default.** It would
strand every existing install's settings.

`APP_ID` is deliberately separate from `APP_NAME`, which is cosmetic: renaming a
deployment must not move the documents its users already read.

A fork that changes `VITE_APP_ID` must also change
`SelfState.DEFAULT_D_TAGS` in the Android service — see below.

## Rules a writer must keep

1. **Never publish before the document has been read.** `useSettingsDoc.update`
   merges its patch over `{}` when the store holds nothing, and these are
   replaceable events, so publishing then replaces the user's real document with
   whatever subset the caller passed — on every device. A caller that publishes
   on its own schedule gates on `isFetched` (read-state, reactions) or on the
   metadata document's existence (`useConfigDocSync`, for which
   `metadata === null` means "this user has no Armada settings at all").
2. **The metadata writer strips the migrated fields.** See the migration
   section — this is what makes the timestamp comparison there mean anything.
3. **`lastSync` goes on `metadata` only.** Nothing here reads it; it exists
   because older Armada builds order metadata versions by it rather than by
   `created_at`. Every split document postdates those builds.
4. **ArmadaDB is the model.** `useSettingsDoc` never reads a relay. Documents
   reach disk from the standing REQ, from the Android notification service
   writing the same SQLite file while the app is dead, and from
   `useInitialSync`'s cold-boot read. The store settles versions by NIP-01
   addressable supersession, so "the document on disk" is by construction the
   newest one this device has seen from any source — which is why a write
   re-reads the store rather than trusting the query cache.
5. **Writes to one document are serialized, and the query cache is not allowed
   to regress.** A write spans a store read and two signer round-trips —
   seconds on a NIP-46 signer — so two edits back to back (rail drags) would
   otherwise merge over the same previous version and stamp the same
   `created_at`, and the later edit could lose the NIP-01 tie to the earlier
   one. `serializeSettingsWrite` chains them per document. The cache is the
   softer surface: a refetch (triggered by the previous version's own relay
   echo) that read the store before a write landed can resolve after the
   write's `setQueryData` and put the older version back, which
   `useConfigDocSync` would fold over the user's newest edit. Three defenses,
   each sufficient alone: the write cancels in-flight queries before
   `setQueryData`; the sync hook's apply guard stays up while a publish is in
   flight (not just while its debounce pends); and the apply effect refuses
   any event older than one it has already applied.

## The migration window

Before the split, everything was in `armada/metadata`. The migration is **lazy**
— there is no boot-time write storm, and no publish built over a read that might
have failed. A split document appears the first time its domain is written.

Resolution while both exist (`resolveLegacy` in `settingsDocs.ts`):

- Metadata carries none of the document's fields → use the split document.
- Only metadata carries them → use those, identified by the *metadata* event
  (so an applied-once guard re-fires when the legacy source is superseded).
- Both → **whichever event is newer wins.** A device on an older build writes
  the rail into metadata because that is the only document it knows; a device on
  this build writes `armada/rail`. Both are legitimate, so this self-heals in
  either direction instead of letting one build permanently shadow the other.

That comparison is only sound because this build **strips** the migrated fields
from every metadata write (`stripMigratedKeys`). Otherwise an unrelated theme
change would bump metadata's `created_at` past the rail document's and restore a
stale rail. Their presence is therefore proof that an *older* build wrote that
document.

Convergence: once the user's last old install is upgraded, metadata stops
carrying them and `resolveLegacy` becomes an identity on the split document.

`read-state` and `reactions` skip the arbitration entirely: their merges are
commutative (max timestamp, max count), so both sources are simply hydrated and
the merge sorts it out.

`railOrder` is a second legacy spelling — the pre-folder flat list that was
written alongside `railLayout` for a while. `railLayoutOf` seeds a layout from
it when no layout exists. Nothing writes it; it is `flattenLayout(railLayout)`
and keeping it as a second stored copy only created two things that could
disagree.

## The Android service

`NotificationRelayService` subscribes to and stores these documents while the
app is dead, so a change made on another device is already on disk at next open.
It needs the tag set **before any WebView has run** (a cold boot reads prefs and
opens sockets long before the app is opened), so it carries
`SelfState.DEFAULT_D_TAGS` alongside the `selfDTags` list the plugin config
supplies.

- Absent config means "use the default", never "use nothing" — an empty set
  would drop the kind-30078 subscription entirely. That is also what an older
  WebView, which doesn't send the field, gets.
- The REQ builder and `SelfState.storable` must use the **same** set, or the
  service subscribes to documents it then refuses to store.
- `settingsDocs.test.ts` reads `SelfState.kt` and asserts the default set
  matches `SETTINGS_DOC_NAMES`. Drift is otherwise silent, and shows up only as
  "that one setting doesn't travel between my devices".

Nothing native decrypts these; storing the raw event verbatim is the whole job.

## What is deliberately NOT here

- **Per-device state**, which never syncs: `railOpenFolders`,
  `collapsedChannelCategories`, `memberListVisible`, `lastChannelByServer`
  (syncing it makes two open clients yank each other's channel selection
  around), and `meshEnabled` / `meshIncognito` (they gate a Bluetooth foreground
  service and must never be flipped on remotely).
- **Lists with a canonical home**: `searchRelays` (10007), `dmRelays` (10050),
  `relayMetadata` (10002), `blossomServerMetadata` (10063). AppConfig keeps
  local mirrors; the standard events own them. The metadata schema still
  declares them because `useInitialSync` reads them **once**, to rescue a user
  whose canonical event doesn't exist yet. Nothing writes them.
- **`PushPrefs`** (`src/lib/pushPrefs.ts`) — the account-global per-type
  notification prefs, in plain localStorage under `armada:push-prefs`. The one
  settings surface outside both AppConfig and NIP-78.
- **GIF favorites**, which use kind 30078 but a different scheme: one
  per-installation shard at `armada/gif-favorites/<deviceId>`, discovered by the
  `t` tag `armada-gif-favorites` rather than by `d`. Merging shards gives
  add/remove convergence without one upgrading device replacing another's list.
- **`themes`** — a per-mode override of the builtin light/dark palettes that
  this client only ever read and never wrote. Removed. The schema is loose, so a
  copy left in an older device's document passes through untouched.

## Known issue: read-state growth

`armada/read-state` grows forever. There is no pruning, and the obvious pruning
rules are worse than the growth: a dropped entry reads back as `0`, i.e. the
conversation reappears as entirely unread. Splitting it out means it no longer
bloats every other write, but the document itself still needs a real answer
eventually — most likely a cut-off tied to what the client will ever render,
rather than an age or a count.

## Adding a document

1. A name in `SETTINGS_DOC_NAMES` (`src/lib/settingsDocs.ts`).
2. A `z.looseObject` schema in `src/lib/schemas.ts`, wired into
   `SETTINGS_DOC_SCHEMAS`.
3. If it mirrors AppConfig: a key list in `src/contexts/AppContext.ts`, an entry
   in `CONFIG_KEYS_BY_DOC` (`src/lib/syncedConfig.ts`), and a
   `useConfigDocSync("<name>")` call in `NostrSync`. Otherwise, an owner module
   that calls `useSettingsDoc("<name>")` and honours rule 1 above.
4. If it takes fields out of an existing document, an entry in `MIGRATED_KEYS`.
5. `SelfState.DEFAULT_D_TAGS` in the Android service.

The schema must stay **loose**. A key this build doesn't know has to survive a
read-modify-write, or a newer Armada on another device loses its settings every
time this one writes.

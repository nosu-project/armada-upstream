import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Native bridge to the Android background notification service
 * (ArmadaNotificationPlugin.java). The service holds a persistent Nostr REQ to
 * the relay and posts native notifications the instant a matching event
 * arrives — instant push with no FCM/Google. iOS/web have no implementation;
 * the plugin calls simply no-op there.
 */
/**
 * A community's icon for the Android per-community group summary. Either a
 * plain public URL (`{ url }` only — NIP-29 group `picture`) or an
 * encrypted-blob pointer the background service fetches and AES-256-GCM
 * decrypts itself: `key`/`nonce` are hex, and `hash` (hex SHA-256 of the
 * plaintext) is verified after decrypt so a swapped blob fails closed. The
 * image key is lower-sensitivity than the identity/channel keys already shared
 * with the service (it only decrypts a public-facing community icon).
 */
export interface CommunityNotifImage {
  url: string;
  /** Hex AES-256-GCM key (encrypted icons only). */
  key?: string;
  /** Hex AES-GCM nonce/IV (encrypted icons only). */
  nonce?: string;
  /** Hex SHA-256 of the plaintext (integrity check; encrypted icons only). */
  hash?: string;
}

export interface ArmadaNotificationPlugin {
  /** Whether POST_NOTIFICATIONS is granted (always true below Android 13). */
  checkPermission(): Promise<{ granted: boolean }>;
  /** Prompt for POST_NOTIFICATIONS (Android 13+). */
  requestPermission(): Promise<{ granted: boolean }>;
  /**
   * Android: whether the app is exempt from battery optimizations (Doze).
   * Battery optimization tears down the persistent relay websockets while the
   * device is idle, and on Android 15+ the exemption is also required for the
   * boot receiver to restart the service after a reboot.
   */
  isIgnoringBatteryOptimizations(): Promise<{ ignoring: boolean }>;
  /** Android: show the one-tap system dialog to grant the exemption. */
  requestIgnoreBatteryOptimizations(): Promise<void>;
  /** Hand a signed NIP-42 kind-22242 event back to the service for a relay. */
  submitAuth(options: { relayUrl: string; event: NostrEvent }): Promise<void>;
  /**
   * Drain raw outer wire events the background service received, oldest first.
   * The JS layer routes each through wire ingest, then calls {@link ackDrain}
   * with the returned ids so the page isn't replayed. Loss-proof across service
   * restarts and webview crashes (peek+ack, database-backed).
   *
   * This is ROUTING, not storage. The events themselves are already in ArmadaDB
   * — the service and the WebView share one native store, so it wrote them into
   * the same tenants the app reads. What a drain still buys is a pass through
   * ingest: parking undecryptable wraps, ringing the scopes that repaint a
   * timeline, feeding notification candidates.
   *
   * A page is ONE RELAY's worth, and `relay` names it. The queue is a tenant per
   * relay precisely so this can be answered: the WebView's ingest routes NIP-29
   * events into the tenant for the relay that served them, and a rumor carries
   * no record of that (nor may one be injected into it — its tags are the bytes
   * its id commits to, and a `relay` tag would be forgeable by any sender). The
   * queue tenant's own id is the unforgeable place that fact can live. `relay` is
   * absent only for a page drained from the pre-upgrade unscoped queue.
   */
  drainEvents(): Promise<{ events: string[]; ids: string[]; relay?: string }>;
  /**
   * Drop an acknowledged page from the queue, once it has been ingested. `relay`
   * must be the value {@link drainEvents} returned with the page: it selects the
   * queue tenant the ids are removed from.
   */
  ackDrain(options: { ids: string[]; relay?: string }): Promise<void>;
  /**
   * Drain (and clear) the pending "Mark read" markers the background service
   * recorded when the user tapped a notification's "Mark read" action. Each
   * carries the room key and the unix-seconds timestamp to mark read up to.
   * The JS layer maps each to the right per-protocol read-state write.
   * No-ops (empty array) on web/iOS.
   */
  drainReadMarkers(): Promise<{
    markers: Array<{ room: string; ts: number }>;
  }>;
  /**
   * The service's rolling per-room cache of raw outer wire events (newest
   * last). Unlike {@link drainEvents} — a one-shot global buffer of what
   * arrived while the WebView was down — this retains the last screenful PER
   * ROOM for the whole service lifetime, so opening a room from a notification
   * can paint natively-received history even if the global buffer overflowed.
   * Room keys: `h:<groupId>` (NIP-29), `c2:<channelId>` (Concord),
   * `dm` (kind 4).
   */
  getRoomEvents(options: { room: string }): Promise<{ events: string[] }>;
  /**
   * Fired when a relay issues a NIP-42 AUTH challenge. The JS layer signs the
   * Concord V2 stream auths (their derived keys live JS-side) and the user's
   * kind-22242, then calls submitAuth. The service ALSO signs the user's
   * 22242 itself when a signer credential was shared (configure's `signer`),
   * so auth-gated relays keep working with the app dead.
   */
  addListener(
    eventName: "authChallenge",
    listener: (data: { relayUrl: string; challenge: string }) => void,
  ): Promise<PluginListenerHandle>;
  /**
   * Fired when the background service receives a raw outer event (NIP-29 kind
   * 9/1068/7/1111/5, a kind-4 DM, or a Concord kind-1059 wrap) while the
   * WebView is up. The JS layer writes it
   * straight into its event store, so the live timeline shows it with zero
   * relay latency — the same message the notification was about.
   *
   * `relay` is the relay it arrived from, which the store needs to file a
   * group-scoped event under the right server (see `db/relayScope.ts`).
   */
  addListener(
    eventName: "relayEvent",
    listener: (data: { event: string; relay?: string }) => void,
  ): Promise<PluginListenerHandle>;
  /**
   * Tell the running service which roomKey(s) the WebView is currently showing
   * (so it can suppress redundant notifications for those rooms — the live
   * timeline already paints the message). Pass an empty array when the app is
   * backgrounded or on a non-chat screen. The value is volatile: it lives
   * only on the running service instance, so killing the app or the service
   * immediately resumes notifications. Mentions still notify on an active
   * room (a deliberate @-ping deserves attention even on the visible channel).
   *
   * Room-key shapes (must match the service's enqueueRoomMessage keys):
   *   - NIP-29 group: `h:<relayUrl>|<groupId>`
   *   - Concord:      `c2:<channelIdHex>`
   *   - DM:           `dm:<peerPubkey>`
   */
  setActiveRooms(options: { roomKeys: string[] }): Promise<void>;
  /**
   * Cancel tray notifications for conversations the in-app read state now
   * covers (read here, or synced in from another device). Each marker is a
   * read-state key (`dm:<pk>` / `c2:<id>` / `<relayUrl>::<groupId>`)
   * and its last-read unix seconds; the running service cancels the matching
   * room's notification when the room's newest notified message is at/older than
   * that stamp — the reverse of a notification's "Mark read" tap. No-ops on
   * web/iOS and when the service posted nothing.
   */
  dismissRead(options: { markers: Array<{ room: string; ts: number }> }): Promise<void>;
  /**
   * Configure (and start/stop) the background service. Passing `enabled: false`
   * or omitting pubkey/relays stops the service and clears stored config.
   */
  configure(options: {
    enabled: boolean;
    userPubkey?: string;
    /** Relay websocket URLs to hold open. */
    relayUrls?: string[];
    /** Joined group ids (the `h` tag values) for the kind-9 filter. */
    groupIds?: string[];
    /**
     * Joined NIP-29 groups mapped to their single host relay. A NIP-29 group
     * is intrinsically tied to one relay, so the service scopes each relay's
     * kind-9/7/1111 REQ to just the groups that relay hosts — rather than
     * broadcasting every joined id to every relay. Supersedes the flat
     * `groupIds`/`relayUrls` pairing; `groupIds` is still sent so an older
     * native binary (which ignores this field) keeps working.
     */
    groupSubs?: Array<{ relay: string; id: string }>;
    /**
     * Subset of `groupIds` whose notification level is "mentions only" — the
     * service still subscribes (so mentions land) but should suppress non-
     * mention messages for these groups. Older native binaries that don't know
     * this field simply notify on all messages for them (graceful downgrade).
     */
    mentionOnlyGroupIds?: string[];
    /** Relays to read DMs (kind 4) from — the app/DM relays, not group relays. */
    dmRelays?: string[];
    /**
     * People the user follows (kind 3 pubkeys, hex). The kind-4 DM subscription
     * is scoped to `authors:[...dmFollows]` so only DMs from friends notify
     * (permanent friends-only). Empty ⇒ no DM subscription at all.
     */
    dmFollows?: string[];
    /**
     * The "known" DM peers (hex): follows ∪ accepted ∪ pinned — the WebView's
     * `useKnownDmPeers` set. A NIP-17 wrap can come from anyone, so this is what
     * lets the service tell a friend's DM from a stranger's AFTER decrypting it
     * (the kind-4 sub is already follows-scoped at the relay; kind-1059 can't
     * be). A peer NOT in this set is a request, gated by `dmRequests`. Older
     * native binaries ignore this field and notify every DM in full.
     */
    dmKnownPeers?: string[];
    /**
     * How to notify for a DM from an unknown sender (not in `dmKnownPeers`):
     * `"off"` (silent), `"generic"` (a content-blind request ping), or `"full"`
     * (name + avatar + preview, as for a known sender). Absent/unknown ⇒ the
     * service treats it as `"generic"`, the safe default.
     */
    dmRequests?: string;
    /**
     * The relays carrying the user's OWN replaceable documents — the general
     * pool (app relays + their NIP-65 read relays). On these the service also
     * subscribes to the self-state catalogue (follow/mute lists, the kind-10009
     * server list, the Concord vaults, and the NIP-78 settings document that
     * holds the community rail's arrangement) and files each version in the
     * `main` tenant the WebView reads, so a change made on another device is
     * already on disk when the app next opens.
     *
     * Distinct from `relayUrls`, which is the NIP-29 server set: a user with no
     * servers has none, and their settings live on the app relays regardless.
     * An older native binary ignores this field and simply doesn't mirror them.
     */
    selfRelays?: string[];
    /** Per-type notification prefs (mentions/reactions/replies/directMessages/allGroupMessages). */
    prefs?: Record<string, boolean>;
    /**
     * Concord V2 (CORD-02) channel subscriptions. The service subscribes
     * `{kinds:[1059], authors:[…stream pk]}` per relay and uses the supplied
     * per-stream NIP-44 conversation key to open wrap → seal → rumor for a
     * rich "<sender>: <preview>" notification deep-linking to
     * /c/<communityId>/<channelId>. Stream SECRET keys never cross this
     * bridge — NIP-42 stream auth is signed in the WebView (authChallenge),
     * and the notification quick reply's wrap is signed with the derived
     * stream key the service reads from the group-key memo already persisted
     * in the shared ArmadaDB (`c2gkmemo`, see groupKeyPersist.ts).
     */
    concord2Subs?: Array<{
      relays: string[];
      communityId: string;
      communityName: string;
      channelId: string;
      channelName: string;
      streams: Array<{ pk: string; convKey: string; epoch: string }>;
      /**
       * The community's icon for the per-community group summary — see
       * {@link CommunityNotifImage}. For V2 this is the encrypted CORD-02 §6
       * icon pointer; the service fetches the blob, AES-GCM decrypts with the
       * shipped key/nonce, and verifies the plaintext hash before display.
       * Omitted when the community has no icon.
       */
      communityImage?: CommunityNotifImage;
      /** "mentions only" — suppress non-mention messages (older binaries notify all). */
      mentionOnly?: boolean;
      /**
       * CORD-08 disappearing-message timer (seconds; 0/absent = off) so the
       * native quick reply stamps its rumor + wrap with the NIP-40 deadline.
       */
      timerSecs?: number;
    }>;
    /**
     * The user's signer credential, shared with the service so it can open
     * ANY gift wrap addressed to the user (rich DM notifications regardless
     * of sender client) and answer NIP-42 AUTH challenges with the app dead.
     * One shape per login type; the native side seals it with an Android
     * Keystore key before persisting and wipes it with the config on
     * disable/logout:
     *   - nsec:   the raw identity key (hex) — already resident in this same
     *             app sandbox (localStorage); native storage is sealed, so
     *             at-rest posture strictly improves.
     *   - amber:  the NIP-55 signer app's package name; the service queries
     *             its ContentResolver directly (background grant required).
     *   - nip46:  the bunker session — the pairing's CLIENT key, bunker
     *             pubkey and bunker relays; the service runs its own
     *             kind-24133 RPC channel. The identity key stays in the
     *             bunker, exactly as the user chose.
     */
    signer?:
      | { type: "key"; sk: string }
      | { type: "amber"; packageName: string }
      | { type: "nip46"; clientSk: string; bunkerPk: string; relays: string[] };
    /** Public NIP-34 activity attached to Concord V2 channels. Mapping an
     * attachment to its private channel remains local to Android; relay filters
     * contain only the public repository coordinate and ticket ids. */
    gitSubs?: Array<{
      address: string;
      relays: string[];
      owner: string;
      maintainers?: string[];
      attachments: Array<{ communityId: string; channelId: string; attachedAt: number; detachedAt?: number }>;
      ticketRoots: Array<{ id: string; author: string; kind: 1618 | 1621 }>;
    }>;
  }): Promise<void>;
}

export const ArmadaNotification =
  registerPlugin<ArmadaNotificationPlugin>("ArmadaNotification");

/**
 * Check whether Armada is exempt from Android battery optimizations.
 *
 * Returns `true` (exempt / nothing to do) on non-Android platforms or when
 * the native method is unavailable (older app binary), so callers never show
 * a false warning.
 */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (Capacitor.getPlatform() !== "android") return true;
  try {
    const { ignoring } = await ArmadaNotification.isIgnoringBatteryOptimizations();
    return ignoring;
  } catch {
    return true;
  }
}

/**
 * Open the one-tap system dialog asking the user to exempt Armada from
 * battery optimizations. No-op outside Android.
 */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  if (Capacitor.getPlatform() !== "android") return;
  try {
    await ArmadaNotification.requestIgnoreBatteryOptimizations();
  } catch (err) {
    console.warn("[native-notif] Failed to request battery optimization exemption:", err);
  }
}

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Native bridge to the Android background notification service
 * (ArmadaNotificationPlugin.java). The service holds a persistent Nostr REQ to
 * the relay and posts native notifications the instant a matching event
 * arrives — instant push with no FCM/Google. iOS/web have no implementation;
 * the plugin calls simply no-op there.
 */
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
   * Drain raw outer wire events the background service received while the WebView
   * was down (it buffers them). The JS layer writes each into its event store so
   * a freshly-opened app already holds the messages the notifications were about.
   * Concord decrypted inners are drained separately via {@link drainConcord} so
   * the two consumers don't race to empty a shared buffer.
   */
  drainEvents(): Promise<{ events: string[] }>;
  /**
   * Drain Concord inner events the service already decrypted (it holds the
   * channel key for the notification), each with the outer `z` pseudonym and
   * outer id. The open channel verifies the inner signature + binding and folds
   * it straight in — no second decrypt, no relay round-trip — so a tapped
   * notification's message is on screen at once.
   */
  drainConcord(): Promise<{ concord: Array<{ inner: string; z: string; outerId: string }> }>;
  /**
   * The service's rolling per-room cache of raw outer wire events (newest
   * last). Unlike {@link drainEvents} — a one-shot global buffer of what
   * arrived while the WebView was down — this retains the last screenful PER
   * ROOM for the whole service lifetime, so opening a room from a notification
   * can paint natively-received history even if the global buffer overflowed.
   * Room keys: `h:<groupId>` (NIP-29), `z:<pseudonym>` (Concord V1),
   * `c2:<channelId>` (Concord V2), `dm` (kind 4).
   */
  getRoomEvents(options: { room: string }): Promise<{ events: string[] }>;
  /**
   * Fired when a relay issues a NIP-42 AUTH challenge. The JS layer signs a
   * kind-22242 with the user's signer and calls submitAuth — so no private key
   * ever enters native code, and bunker/extension signers work too.
   */
  addListener(
    eventName: "authChallenge",
    listener: (data: { relayUrl: string; challenge: string }) => void,
  ): Promise<PluginListenerHandle>;
  /**
   * Fired when the background service receives a raw outer event (NIP-29 kind
   * 9/1068/7/1111/5, a kind-4 DM, a Concord V1 sealed kind 3300, or a Concord
   * V2 kind-1059 wrap) while the WebView is up. The JS layer writes it
   * straight into its event store, so the live timeline shows it with zero
   * relay latency — the same message the notification was about.
   */
  addListener(
    eventName: "relayEvent",
    listener: (data: { event: string }) => void,
  ): Promise<PluginListenerHandle>;
  /**
   * Fired when the background service receives AND decrypts a Concord message
   * (kind 3300) while the WebView is up. Carries the decrypted inner event JSON,
   * the outer `z` pseudonym, and the outer event id. The WebView verifies the
   * inner Schnorr signature + channel/epoch binding (the service only checked
   * HMAC + binding) and folds it into the open channel — instant render, no
   * second decrypt, no relay round-trip.
   */
  addListener(
    eventName: "concordMessage",
    listener: (data: { inner: string; z: string; outerId: string }) => void,
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
   * A set (not a single key) because a Concord V1 channel can span multiple
   * rekey epochs, each with its own `z` pseudonym — and thus multiple
   * roomKeys — all of which are "active" simultaneously.
   *
   * Room-key shapes (must match the service's enqueueRoomMessage keys):
   *   - NIP-29 group: `h:<relayUrl>|<groupId>`
   *   - Concord V1:   `z:<pseudonym>`
   *   - Concord V2:   `c2:<channelIdHex>`
   *   - DM:           `dm:<peerPubkey>`
   */
  setActiveRooms(options: { roomKeys: string[] }): Promise<void>;
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
    /** Per-type notification prefs (mentions/reactions/replies/directMessages/allGroupMessages). */
    prefs?: Record<string, boolean>;
    /**
     * Concord (E2E) channel subscriptions. The service subscribes by `#z`
     * pseudonym (kind 3300) and uses the supplied per-`z` channel key to open
     * the sealed message (NIP-44 v2) for a rich "<sender>: <preview>"
     * notification in <community> / #<channel>.
     */
    concordSubs?: Array<{
      relays: string[];
      zs: string[];
      keys: Array<{ z: string; key: string; channelId: string; epoch: string }>;
      communityId: string;
      communityName: string;
      channelName: string;
      /** "mentions only" — suppress non-mention messages (older binaries notify all). */
      mentionOnly?: boolean;
    }>;
    /**
     * Concord V2 (CORD-02) channel subscriptions. The service subscribes
     * `{kinds:[1059], authors:[…stream pk]}` per relay and uses the supplied
     * per-stream NIP-44 conversation key to open wrap → seal → rumor for a
     * rich "<sender>: <preview>" notification deep-linking to
     * /c/<communityId>/<channelId>. Stream SECRET keys never cross this
     * bridge — NIP-42 stream auth is signed in the WebView (authChallenge).
     */
    concord2Subs?: Array<{
      relays: string[];
      communityId: string;
      communityName: string;
      channelId: string;
      channelName: string;
      streams: Array<{ pk: string; convKey: string; epoch: string }>;
      /** "mentions only" — suppress non-mention messages (older binaries notify all). */
      mentionOnly?: boolean;
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

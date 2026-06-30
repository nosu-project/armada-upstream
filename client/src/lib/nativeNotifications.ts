import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

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
   * 9/1068/7/1111/5 or a Concord sealed kind 3300) while the WebView is up. The
   * JS layer writes it straight into its event store, so the live timeline shows
   * it with zero relay latency — the same message the notification was about.
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
    /** Relays to read DMs (kind 4) from — the app/DM relays, not group relays. */
    dmRelays?: string[];
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
    }>;
  }): Promise<void>;
}

export const ArmadaNotification =
  registerPlugin<ArmadaNotificationPlugin>("ArmadaNotification");

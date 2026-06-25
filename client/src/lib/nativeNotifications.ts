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
   * Fired when a relay issues a NIP-42 AUTH challenge. The JS layer signs a
   * kind-22242 with the user's signer and calls submitAuth — so no private key
   * ever enters native code, and bunker/extension signers work too.
   */
  addListener(
    eventName: "authChallenge",
    listener: (data: { relayUrl: string; challenge: string }) => void,
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

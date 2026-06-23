import { registerPlugin } from "@capacitor/core";

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
    /** Per-type notification prefs (mentions/reactions/replies/directMessages/allGroupMessages). */
    prefs?: Record<string, boolean>;
    /**
     * Concord (E2E) channel subscriptions. The service can't decrypt these, so
     * it subscribes by `#z` pseudonym (kind 3300) and fires a generic
     * "New message in <community> / #<channel>" notification.
     */
    concordSubs?: Array<{
      relays: string[];
      zs: string[];
      communityId: string;
      communityName: string;
      channelName: string;
    }>;
  }): Promise<void>;
}

export const ArmadaNotification =
  registerPlugin<ArmadaNotificationPlugin>("ArmadaNotification");

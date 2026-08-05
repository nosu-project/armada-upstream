/**
 * The account-global notification preferences, and the interface a push
 * controller hook exposes to the settings UI.
 *
 * These are shared by every notification path — the content-blind nostr-push
 * gateway (`useNostrPush`), the Android background service
 * (`useNativeNotifications`), the in-app foreground notifier
 * (`useForegroundNotificationSettings`) and the per-channel level resolver
 * (`useNotifLevels`) — so they live outside any one of them. They are stored
 * under `armada:push-prefs`, which each path reads directly.
 */

import type { WebPushUnavailableReason } from "@/lib/webPushSupport";

/** Discord-style per-type notification preferences. */
export interface PushPrefs {
  /** Messages that mention you (p-tag). Default on. */
  mentions: boolean;
  /** Reactions to your messages. Default on. */
  reactions: boolean;
  /** Replies to your messages. Default on. */
  replies: boolean;
  /** Direct messages. Default on. */
  directMessages: boolean;
  /** Every message in your groups (not just mentions). Default on. */
  allGroupMessages: boolean;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  mentions: true,
  reactions: true,
  replies: true,
  directMessages: true,
  allGroupMessages: true,
};

/** What a push-notifications hook hands the settings UI. */
export interface UsePushNotificationsReturn {
  /** Whether this browser/environment supports Web Push against a configured gateway. */
  supported: boolean;
  /** Exact unavailable layer, so the UI does not mistake every failure for an old OS. */
  unavailableReason?: WebPushUnavailableReason;
  /** Whether the service worker and VAPID key are ready for a gesture-bound subscribe call. */
  ready: boolean;
  /** Recoverable preparation/registration failure, if one occurred. */
  error?: string;
  /** Current Notification permission. */
  permission: NotificationPermission;
  /** Whether push is currently active (subscribed + registered). */
  enabled: boolean;
  /** Whether an enable/disable/sync operation is in flight. */
  busy: boolean;
  /** Current notification preferences. */
  prefs: PushPrefs;
  /** Request permission, subscribe, and register with the gateway. */
  enable: () => Promise<void>;
  /** Unsubscribe and delete the server record. */
  disable: () => Promise<void>;
  /** Update preferences; re-syncs the server record when enabled. */
  setPrefs: (next: PushPrefs) => Promise<void>;
  /** Retry service-worker/VAPID preparation and server registration. */
  retry: () => void;
}

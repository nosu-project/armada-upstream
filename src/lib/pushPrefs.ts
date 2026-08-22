/**
 * The account-global notification preferences, and the interface a push
 * controller hook exposes to the settings UI.
 *
 * These are shared by every notification path — the content-blind nostr-push
 * gateway (`useNostrPush`), the Android background service
 * (`useNativeNotifications`), the in-app foreground notifier
 * (`useForegroundNotificationSettings`) and the per-channel level resolver
 * (`useNotifLevels`) — so they live outside any one of them. They are stored
 * in encrypted account settings. The localStorage mirror remains because the
 * service worker and Android background service need the value without React;
 * `NostrSync` refreshes that mirror when another client changes the document.
 */

import type { WebPushUnavailableReason } from "@/lib/webPushSupport";
import { accountScopedKey, getActivePubkey } from "@/lib/activeAccount";

const PUSH_PREFS_KEY = "armada:push-prefs";

function pushPrefsKey(pubkey?: string | null): string {
  return accountScopedKey(PUSH_PREFS_KEY, pubkey === undefined ? getActivePubkey() : pubkey);
}

/**
 * How to notify for a DM from someone the user doesn't know — not followed,
 * not accepted (never replied to / composed to), not pinned. A stranger
 * controls every field a full DM notification surfaces: the message text, their
 * display name AND their avatar. So the default is a content-blind "message
 * request" ping that reveals none of it, rather than letting a random push
 * whatever they wrote (and named themselves) straight onto the lock screen.
 *
 *   off     — no notification at all for unknown senders
 *   generic — a fixed "message request" ping: no sender name, avatar, or preview
 *   full    — notify exactly like a known sender (name + avatar + preview)
 *
 * Only consulted when `directMessages` is on; known senders always notify in
 * full. The message is stored either way and appears in the DM requests tier on
 * open — this governs only whether/how it interrupts.
 */
export type DmRequestLevel = "off" | "generic" | "full";

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
  /** How to notify for DMs from unknown senders. Default `generic`. */
  dmRequests: DmRequestLevel;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  mentions: true,
  reactions: true,
  replies: true,
  directMessages: true,
  allGroupMessages: true,
  dmRequests: "generic",
};

/** Read the account-global per-type prefs from localStorage, defaults merged. */
export function loadPushPrefs(pubkey?: string | null): PushPrefs {
  try {
    const raw = localStorage.getItem(pushPrefsKey(pubkey));
    if (raw) return { ...DEFAULT_PUSH_PREFS, ...JSON.parse(raw) };
  } catch {
    // ignore — fall through to defaults
  }
  return { ...DEFAULT_PUSH_PREFS };
}

/** Persist the local mirror consumed by background notification runtimes. */
export function savePushPrefs(next: PushPrefs, pubkey?: string | null): void {
  try {
    localStorage.setItem(pushPrefsKey(pubkey), JSON.stringify(next));
  } catch {
    // localStorage unavailable — the in-memory AppConfig value still applies.
  }
}

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

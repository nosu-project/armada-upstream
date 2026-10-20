/**
 * Runtime prerequisites for Web Push. Deliberately excludes the Notifications
 * API: some iOS Home-Screen builds lack `window.Notification` while Push and
 * `showNotification()` work.
 */
export interface WebPushCapabilities {
  secureContext: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  /** WebKit's Push API (iOS/iPadOS, Safari on macOS). */
  webkit: boolean;
}

export type WebPushUnavailableReason =
  | "native-runtime"
  | "desktop"
  | "gateway"
  | "webkit"
  | "insecure-context"
  | "service-worker"
  | "push-manager";

/**
 * Whether this browser's Web Push is WebKit's: every iOS browser, and Safari on
 * macOS. WebKit revokes a subscription whose pushes show nothing, so each push
 * that decrypts to no news would still have to post a notification.
 */
export function isWebKitPush(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return true;
  return /Version\/[\d.]+.*Safari\//.test(userAgent)
    && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(userAgent);
}

/** Read browser capabilities without throwing in SSR/tests. */
export function webPushCapabilities(): WebPushCapabilities {
  return {
    secureContext: typeof isSecureContext === "undefined" || isSecureContext,
    serviceWorker: typeof navigator !== "undefined" && "serviceWorker" in navigator,
    pushManager: typeof window !== "undefined" && "PushManager" in window,
    webkit: typeof navigator !== "undefined"
      && isWebKitPush(navigator.userAgent, navigator.maxTouchPoints),
  };
}

/** The first missing prerequisite, or undefined when background push can run. */
export function webPushUnavailableReason(
  gatewayConfigured: boolean,
  capabilities: WebPushCapabilities = webPushCapabilities(),
): WebPushUnavailableReason | undefined {
  if (capabilities.webkit) return "webkit";
  if (!gatewayConfigured) return "gateway";
  if (!capabilities.secureContext) return "insecure-context";
  if (!capabilities.serviceWorker) return "service-worker";
  if (!capabilities.pushManager) return "push-manager";
  return undefined;
}

/** Push permission spelling used by the Push API vs the Notifications API. */
export function notificationPermissionOf(state: PermissionState): NotificationPermission {
  return state === "prompt" ? "default" : state;
}

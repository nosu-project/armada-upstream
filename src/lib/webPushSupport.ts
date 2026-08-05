/**
 * The runtime pieces Web Push needs before Armada talks to its push gateway.
 *
 * Keep the Notifications API out of this list. Mobile Safari has shipped
 * Home-Screen web-app builds where `window.Notification` is absent while the
 * standards-based Push API and `ServiceWorkerRegistration.showNotification()`
 * still work. `PushManager.subscribe()` is both the permission request and the
 * subscription operation in that environment.
 */
export interface WebPushCapabilities {
  secureContext: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
}

export type WebPushUnavailableReason =
  | "native-runtime"
  | "gateway"
  | "insecure-context"
  | "service-worker"
  | "push-manager";

/** Read browser capabilities without throwing in SSR/tests. */
export function webPushCapabilities(): WebPushCapabilities {
  return {
    secureContext: typeof isSecureContext === "undefined" || isSecureContext,
    serviceWorker: typeof navigator !== "undefined" && "serviceWorker" in navigator,
    pushManager: typeof window !== "undefined" && "PushManager" in window,
  };
}

/** The first missing prerequisite, or undefined when background push can run. */
export function webPushUnavailableReason(
  gatewayConfigured: boolean,
  capabilities: WebPushCapabilities = webPushCapabilities(),
): WebPushUnavailableReason | undefined {
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

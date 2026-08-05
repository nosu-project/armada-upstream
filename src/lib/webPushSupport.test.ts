import { describe, expect, it } from "vitest";

import {
  notificationPermissionOf,
  webPushUnavailableReason,
  type WebPushCapabilities,
} from "./webPushSupport";

const available: WebPushCapabilities = {
  secureContext: true,
  serviceWorker: true,
  pushManager: true,
};

describe("webPushUnavailableReason", () => {
  it("supports PushManager without requiring the window Notification API", () => {
    expect(webPushUnavailableReason(true, available)).toBeUndefined();
  });

  it("reports deployment and runtime failures separately", () => {
    expect(webPushUnavailableReason(false, available)).toBe("gateway");
    expect(webPushUnavailableReason(true, { ...available, secureContext: false })).toBe(
      "insecure-context",
    );
    expect(webPushUnavailableReason(true, { ...available, serviceWorker: false })).toBe(
      "service-worker",
    );
    expect(webPushUnavailableReason(true, { ...available, pushManager: false })).toBe(
      "push-manager",
    );
  });
});

describe("notificationPermissionOf", () => {
  it("maps Push API prompt state to Notification permission default", () => {
    expect(notificationPermissionOf("prompt")).toBe("default");
    expect(notificationPermissionOf("granted")).toBe("granted");
    expect(notificationPermissionOf("denied")).toBe("denied");
  });
});

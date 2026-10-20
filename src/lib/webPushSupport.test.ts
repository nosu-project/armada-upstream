import { describe, expect, it } from "vitest";

import {
  isWebKitPush,
  notificationPermissionOf,
  webPushUnavailableReason,
  type WebPushCapabilities,
} from "./webPushSupport";

const available: WebPushCapabilities = {
  secureContext: true,
  serviceWorker: true,
  pushManager: true,
  webkit: false,
};

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  macEdge: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
};

describe("isWebKitPush", () => {
  it("matches every iOS browser and Safari on macOS", () => {
    expect(isWebKitPush(UA.iphone)).toBe(true);
    expect(isWebKitPush(UA.iphoneChrome)).toBe(true);
    expect(isWebKitPush(UA.macSafari)).toBe(true);
  });

  it("matches an iPad presenting a Mac user agent", () => {
    expect(isWebKitPush(UA.macChrome, 5)).toBe(true);
  });

  it("leaves Chromium and Gecko browsers alone", () => {
    expect(isWebKitPush(UA.macChrome)).toBe(false);
    expect(isWebKitPush(UA.macEdge)).toBe(false);
    expect(isWebKitPush(UA.macFirefox)).toBe(false);
    expect(isWebKitPush(UA.android)).toBe(false);
  });
});

describe("webPushUnavailableReason", () => {
  it("supports PushManager without requiring the window Notification API", () => {
    expect(webPushUnavailableReason(true, available)).toBeUndefined();
  });

  it("refuses WebKit even when every prerequisite is present", () => {
    expect(webPushUnavailableReason(true, { ...available, webkit: true })).toBe("webkit");
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

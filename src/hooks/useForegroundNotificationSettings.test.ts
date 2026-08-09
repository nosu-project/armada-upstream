import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  enableForegroundNotifications,
  foregroundNotifyIntent,
  isForegroundNotifyReady,
} from "./useForegroundNotificationSettings";

const INTENT_KEY = "armada:foreground-notif-intent";

/** Install a Notification stub with a settable permission. */
function stubNotification(permission: NotificationPermission) {
  const requestPermission = vi.fn(async () => permission);
  const stub = { permission, requestPermission };
  Object.defineProperty(globalThis, "Notification", {
    value: stub,
    writable: true,
    configurable: true,
  });
  return stub;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, "Notification");
});

describe("isForegroundNotifyReady", () => {
  it("is FALSE on a fresh profile, where the intent reads on but nothing was granted", () => {
    // This is the trap the whole module exists to close. The intent is
    // opt-out, so it defaults to on; permission starts at "default" and can
    // only be requested from a gesture. A surface consulting the intent alone
    // shows an enabled feature that can never fire — which is exactly what a
    // user reported, and the reason `enabled` is derived from both.
    stubNotification("default");
    expect(foregroundNotifyIntent()).toBe(true);
    expect(isForegroundNotifyReady()).toBe(false);
  });

  it("is true once the intent is on and permission is granted", () => {
    stubNotification("granted");
    expect(isForegroundNotifyReady()).toBe(true);
  });

  it("is false when the user turned the intent off, however permission stands", () => {
    stubNotification("granted");
    localStorage.setItem(INTENT_KEY, "false");
    expect(isForegroundNotifyReady()).toBe(false);
  });

  it("is false when permission is denied", () => {
    stubNotification("denied");
    expect(isForegroundNotifyReady()).toBe(false);
  });

  it("is false where the Notifications API is absent", () => {
    Reflect.deleteProperty(globalThis as object, "Notification");
    expect(isForegroundNotifyReady()).toBe(false);
  });
});

describe("enableForegroundNotifications", () => {
  it("requests permission and turns the intent on", async () => {
    const stub = stubNotification("default");
    stub.requestPermission.mockResolvedValue("granted");
    await expect(enableForegroundNotifications()).resolves.toBe(true);
    expect(stub.requestPermission).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(INTENT_KEY)).toBe("true");
  });

  it("does not re-prompt when permission is already granted", async () => {
    const stub = stubNotification("granted");
    await expect(enableForegroundNotifications()).resolves.toBe(true);
    expect(stub.requestPermission).not.toHaveBeenCalled();
  });

  it("still asks when permission is denied, which resolves without a prompt", async () => {
    // The old code only asked when permission was exactly "default", so a
    // toggle click in any other state was a silent no-op.
    const stub = stubNotification("denied");
    stub.requestPermission.mockResolvedValue("denied");
    await expect(enableForegroundNotifications()).resolves.toBe(false);
    expect(stub.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("reports failure rather than throwing in an insecure context", async () => {
    const stub = stubNotification("default");
    stub.requestPermission.mockRejectedValue(new Error("not allowed"));
    await expect(enableForegroundNotifications()).resolves.toBe(false);
  });

  it("is a no-op where the Notifications API is absent", async () => {
    Reflect.deleteProperty(globalThis as object, "Notification");
    await expect(enableForegroundNotifications()).resolves.toBe(false);
    // Nothing was promised, so nothing is recorded as wanted.
    expect(localStorage.getItem(INTENT_KEY)).toBeNull();
  });
});

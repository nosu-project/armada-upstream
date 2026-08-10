import { beforeEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn((): string => "ios");
const isPluginAvailable = vi.fn((_name: string): boolean => true);
const takePendingOpen = vi.fn(async (): Promise<{ path?: string }> => ({}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => getPlatform(),
    isPluginAvailable: (name: string) => isPluginAvailable(name),
  },
  registerPlugin: () => ({ takePendingOpen: () => takePendingOpen() }),
}));

const { hasIosPush, pushInstallationId, takePendingPushOpen } = await import("@/lib/nativePush");

beforeEach(() => {
  getPlatform.mockClear().mockReturnValue("ios");
  isPluginAvailable.mockClear().mockReturnValue(true);
  takePendingOpen.mockClear().mockResolvedValue({});
  localStorage.clear();
});

describe("hasIosPush", () => {
  it("is true only on iOS with the plugin present", () => {
    expect(hasIosPush()).toBe(true);
  });

  it("is false on Android, which is native but has no implementation", () => {
    // Gating on isNativePlatform() instead would route these calls into a
    // registerPlugin proxy with nothing behind it, where they can only reject.
    // Android does not need it either: its background service holds the relay
    // sockets itself, with no third party in the delivery path.
    getPlatform.mockReturnValue("android");
    expect(hasIosPush()).toBe(false);
  });

  it("is false on the web", () => {
    getPlatform.mockReturnValue("web");
    expect(hasIosPush()).toBe(false);
  });

  it("is false in an iOS build made before the plugin existed", () => {
    isPluginAvailable.mockReturnValue(false);
    expect(hasIosPush()).toBe(false);
  });
});

describe("pushInstallationId", () => {
  it("is stable across calls and persisted", () => {
    const first = pushInstallationId();
    expect(first).toBeTruthy();
    expect(pushInstallationId()).toBe(first);
    localStorage.clear();
    expect(pushInstallationId()).not.toBe(first);
  });
});

describe("takePendingPushOpen", () => {
  it("returns the buffered cold-launch tap path", async () => {
    takePendingOpen.mockResolvedValue({ path: "/dm" });
    await expect(takePendingPushOpen()).resolves.toBe("/dm");
  });

  it("returns null for an ordinary launch", async () => {
    await expect(takePendingPushOpen()).resolves.toBeNull();
  });

  it("refuses a path that is not a router path", async () => {
    // It is fed to navigate(); anything not rooted is not a destination.
    takePendingOpen.mockResolvedValue({ path: "https://evil.example/x" });
    await expect(takePendingPushOpen()).resolves.toBeNull();
  });

  it("does not touch the bridge off iOS", async () => {
    getPlatform.mockReturnValue("android");
    await expect(takePendingPushOpen()).resolves.toBeNull();
    expect(takePendingOpen).not.toHaveBeenCalled();
  });
});

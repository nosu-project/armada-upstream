/**
 * The Android notification diagnostics panel is, by construction, a
 * touch-only surface: it renders only where `useNativeNotifications` is
 * supported, i.e. inside the APK. Its actions are the ones a user reaches
 * precisely when notifications are already broken, so they have to be
 * hittable.
 *
 * AGENTS.md: interactive elements target ≥44px on touch devices via the
 * `touch:` variant. `size="sm"` already carries `touch:h-10`, so these are not
 * untouched by the convention — they simply stop at 40px, below the floor,
 * while the sibling "Preview" button in this same file bumps to it
 * (`h-10 gap-2 touch:h-11`). The explicit `h-8` overrides only the
 * fine-pointer height, so the touch height is whatever the size variant last
 * said.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeNotificationHealth } from "@/lib/nativeNotifications";
import type { UseNativeNotificationsReturn } from "@/hooks/useNativeNotifications";

const h = vi.hoisted(() => ({
  native: undefined as unknown as UseNativeNotificationsReturn,
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }),
}));
vi.mock("@/hooks/useNativeNotifications", () => ({
  useNativeNotifications: () => h.native,
}));
vi.mock("@/contexts/WebPushContext", () => ({
  useWebPushNotifications: () => ({ supported: false }),
}));
vi.mock("@/hooks/useForegroundNotificationSettings", () => ({
  useForegroundNotificationSettings: () => ({
    apiAvailable: false,
    permission: "default",
    enabled: false,
    prefs: {},
    enable: vi.fn(),
    disable: vi.fn(),
    setPrefs: vi.fn(),
  }),
}));
vi.mock("@/lib/nativeNotifications", () => ({
  isIgnoringBatteryOptimizations: vi.fn(async () => true),
  requestIgnoreBatteryOptimizations: vi.fn(),
}));

import { NotificationSettings } from "@/components/NotificationSettings";

/** Every Android channel blocked, so all three actions render at once. */
const BLOCKED_HEALTH: NativeNotificationHealth = {
  postNotificationsGranted: true,
  notificationsEnabled: true,
  messageChannelImportance: 0,
  callChannelImportance: 0,
  serviceChannelImportance: 0,
  activeNotificationCount: 0,
  serviceRunning: true,
  configEnabled: true,
  configRevision: 1,
  loadedConfigRevision: 1,
  lastConfigAt: 0,
  relayWatchCount: 0,
  groupWatchCount: 0,
  dmPeerWatchCount: 0,
  concordStreamWatchCount: 0,
  socketOpenCount: 0,
  socketTotalCount: 0,
  signerStatus: "ready",
  authStatus: "idle",
  lastAuthAt: 0,
  lastSignAt: 0,
  lastEventAt: 0,
  lastPresentedAt: 0,
  lastErrorAt: 0,
};

/** A `touch:` rule that raises the control to the 44px floor. */
const TOUCH_TARGET = /touch:(h-1[12]|min-h-11|size-11)(\s|$)/;

beforeEach(() => {
  h.native = {
    supported: true,
    enabled: true,
    busy: false,
    prefs: {
      mentions: true,
      reactions: true,
      replies: true,
      directMessages: true,
      allGroupMessages: true,
      dmRequests: "generic",
    },
    health: BLOCKED_HEALTH,
    refreshHealth: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    setPrefs: vi.fn(async () => {}),
  };
});

describe("native notification diagnostics touch targets", () => {
  it.each([
    "Open notification settings",
    "Open call settings",
    "Open service settings",
    "Refresh",
  ])("gives %s a coarse-pointer target", (name) => {
    render(<NotificationSettings />);
    const button = screen.getByRole("button", { name });
    expect(button.className).toMatch(TOUCH_TARGET);
  });
});

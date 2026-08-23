// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindingFromKeyboardEvent,
  configureDesktopPushToTalk,
  formatPushToTalkLabel,
  getPushToTalkPreferences,
  onDesktopPushToTalkStatus,
  openDesktopPushToTalkSystemSettings,
  setPushToTalkPreferences,
} from "@/lib/pushToTalk";

afterEach(() => {
  window.localStorage.clear();
  delete window.armadaDesktop;
});

describe("push-to-talk preferences", () => {
  it("survives blocked storage in the render-phase snapshot", () => {
    // getPushToTalkPreferences is the useSyncExternalStore getSnapshot, so it
    // runs DURING render. localStorage throws a SecurityError when the user
    // blocks storage or the app runs in a sandboxed frame, and an unguarded
    // read there takes out the error boundary rather than the feature.
    const real = window.localStorage;
    const denied = () => {
      throw new DOMException("denied", "SecurityError");
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: denied, setItem: denied, removeItem: denied, clear: denied },
    });

    try {
      expect(() => getPushToTalkPreferences()).not.toThrow();
      expect(getPushToTalkPreferences().enabled).toBe(false);
      expect(() => setPushToTalkPreferences({
        enabled: true,
        binding: {
          code: "CapsLock",
          label: "Caps Lock",
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        },
      })).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", { configurable: true, value: real });
    }
  });

  it("records the physical trigger key without duplicating a modifier trigger", () => {
    expect(bindingFromKeyboardEvent({
      code: "ControlLeft",
      key: "Control",
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    })).toEqual({
      code: "ControlLeft",
      label: "Left Ctrl",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });

    expect(bindingFromKeyboardEvent({
      code: "Space",
      key: " ",
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    })?.label).toBe("Ctrl + Shift + Space");
  });

  it("normalizes GNOME's verbose shortcut label", () => {
    expect(formatPushToTalkLabel("Ctrl + Press d")).toBe("Ctrl + D");
    expect(formatPushToTalkLabel("Caps Lock")).toBe("Caps Lock");
  });

  it("persists the preference locally", () => {
    const binding = bindingFromKeyboardEvent({
      code: "KeyV",
      key: "v",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    })!;
    setPushToTalkPreferences({ enabled: true, binding });
    expect(getPushToTalkPreferences()).toEqual({ enabled: true, binding });
  });

  it("configures the isolated desktop bridge", async () => {
    const configurePushToTalk = vi.fn(async () => ({
      supported: true,
      backend: "native" as const,
      bindingLabel: "Caps Lock",
      reason: null,
    }));
    window.armadaDesktop = {
      isDesktop: true,
      setBadge: vi.fn(),
      getInfo: vi.fn(),
      getScreenSources: vi.fn(),
      onPickScreenSource: vi.fn(),
      getMicAccessStatus: vi.fn(),
      openMicPrivacySettings: vi.fn(),
      configurePushToTalk,
    };
    const binding = getPushToTalkPreferences().binding;
    await expect(configureDesktopPushToTalk(binding)).resolves.toMatchObject({ supported: true });
    expect(configurePushToTalk).toHaveBeenCalledWith(binding);
  });

  it("opens and observes the desktop-owned shortcut settings", async () => {
    const openPushToTalkSystemSettings = vi.fn(async () => true);
    let desktopListener: ((status: {
      supported: boolean;
      backend: "portal";
      bindingLabel: string;
      reason: null;
    }) => void) | undefined;
    window.armadaDesktop = {
      isDesktop: true,
      setBadge: vi.fn(),
      getInfo: vi.fn(),
      getScreenSources: vi.fn(),
      onPickScreenSource: vi.fn(),
      getMicAccessStatus: vi.fn(),
      openMicPrivacySettings: vi.fn(),
      openPushToTalkSystemSettings,
      onPushToTalkStatus: (listener) => {
        desktopListener = listener;
        return vi.fn();
      },
    };
    const listener = vi.fn();
    onDesktopPushToTalkStatus(listener);
    const status = {
      supported: true,
      backend: "portal" as const,
      bindingLabel: "Ctrl + X",
      reason: null,
    };
    desktopListener?.(status);

    await expect(openDesktopPushToTalkSystemSettings()).resolves.toBe(true);
    expect(openPushToTalkSystemSettings).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(status);
  });
});

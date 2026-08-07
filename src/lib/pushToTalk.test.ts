import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindingFromKeyboardEvent,
  configureDesktopPushToTalk,
  getPushToTalkPreferences,
  setPushToTalkPreferences,
} from "@/lib/pushToTalk";

afterEach(() => {
  window.localStorage.clear();
  delete window.armadaDesktop;
});

describe("push-to-talk preferences", () => {
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
});

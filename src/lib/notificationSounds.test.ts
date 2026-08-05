import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_NOTIFICATION_SOUND_SETTINGS,
  loadNotificationSoundSettings,
  NOTIFICATION_SOUND_SETTINGS_KEY,
  playNotificationSound,
  saveNotificationSoundSettings,
} from "./notificationSounds";

describe("notification sound settings", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("uses the default signal when no preference exists", () => {
    expect(loadNotificationSoundSettings()).toEqual(DEFAULT_NOTIFICATION_SOUND_SETTINGS);
  });

  it("repairs unknown sounds and clamps stored volume", () => {
    localStorage.setItem(
      NOTIFICATION_SOUND_SETTINGS_KEY,
      JSON.stringify({ enabled: false, sound: "missing", volume: 4 }),
    );

    expect(loadNotificationSoundSettings()).toEqual({
      enabled: false,
      sound: "signal",
      volume: 1,
    });
  });

  it("persists normalized settings", () => {
    const saved = saveNotificationSoundSettings({ enabled: true, sound: "ocean", volume: -1 });

    expect(saved).toEqual({ enabled: true, sound: "ocean", volume: 0 });
    expect(loadNotificationSoundSettings()).toEqual(saved);
  });

  it("previews the selected sound at the selected volume", () => {
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    const instances: Array<{ src: string; volume: number }> = [];

    class MockAudio {
      preload = "";
      volume = 1;
      readonly src: string;
      play = play;
      pause = pause;

      constructor(src: string) {
        this.src = src;
        instances.push(this);
      }
    }
    vi.stubGlobal("Audio", MockAudio);

    playNotificationSound({
      preview: true,
      settings: { enabled: false, sound: "ocean", volume: 0.3 },
    });

    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      src: "/sounds/notifications/ocean.mp3",
      volume: 0.3,
    });
    expect(play).toHaveBeenCalledOnce();
  });
});

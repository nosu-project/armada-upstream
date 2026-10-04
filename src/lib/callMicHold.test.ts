import { afterEach, describe, expect, it, vi } from "vitest";

import { holdCallMic, shouldHoldCallMic } from "./callMicHold";

const platform = vi.hoisted(() => ({ name: "android" }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platform.name, isNativePlatform: () => platform.name !== "web" },
}));

type GetUserMedia = (c: MediaStreamConstraints) => Promise<{ getAudioTracks: () => ReturnType<typeof fakeTrack>[] }>;

/** The audio constraints of the first capture request. */
function firstAudio(getUserMedia: { mock: { calls: [MediaStreamConstraints][] } }): Record<string, unknown> {
  const first = getUserMedia.mock.calls[0];
  if (!first) throw new Error("getUserMedia was not called");
  return first[0].audio as Record<string, unknown>;
}

function fakeTrack() {
  const listeners: Record<string, () => void> = {};
  return {
    stop: vi.fn(),
    addEventListener: (name: string, fn: () => void) => {
      listeners[name] = fn;
    },
    end: () => listeners.ended?.(),
  };
}

describe("shouldHoldCallMic", () => {
  afterEach(() => {
    platform.name = "android";
  });

  it("holds only on Android", () => {
    expect(shouldHoldCallMic()).toBe(true);
    platform.name = "ios";
    expect(shouldHoldCallMic()).toBe(false);
    platform.name = "web";
    expect(shouldHoldCallMic()).toBe(false);
  });
});

describe("holdCallMic", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear?.();
  });

  it("opens a mono capture with echo cancellation on, and stops it on release", async () => {
    const track = fakeTrack();
    const getUserMedia = vi.fn<GetUserMedia>(async () => ({ getAudioTracks: () => [track] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const release = await holdCallMic();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(firstAudio(getUserMedia)).toMatchObject({ echoCancellation: true, channelCount: 1 });
    expect(track.stop).not.toHaveBeenCalled();

    release();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps echo cancellation on even when the publish prefs turn it off", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "armada:voice:processing"
          ? JSON.stringify({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })
          : null,
    });
    const getUserMedia = vi.fn<GetUserMedia>(async () => ({ getAudioTracks: () => [fakeTrack()] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await holdCallMic();
    const audio = firstAudio(getUserMedia);
    expect(audio.echoCancellation).toBe(true);
    expect(audio.noiseSuppression).toBe(false);
  });

  it("reopens the capture once a track ends, but not after release", async () => {
    const first = fakeTrack();
    const second = fakeTrack();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce({ getAudioTracks: () => [first] })
      .mockResolvedValueOnce({ getAudioTracks: () => [second] });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const release = await holdCallMic();
    first.end();
    await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    release();
    expect(second.stop).toHaveBeenCalled();
    second.end();
    await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("rejects when the mic is unavailable", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => { throw new Error("NotAllowedError"); }) },
    });
    await expect(holdCallMic()).rejects.toThrow();
    vi.stubGlobal("navigator", {});
    await expect(holdCallMic()).rejects.toThrow();
  });
});

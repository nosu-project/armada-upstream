import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wrapper carries module-level install state, so each case gets a fresh
// module instance (vi.resetModules + dynamic import) rather than sharing one.
async function freshInstall() {
  vi.resetModules();
  const mod = await import("@/lib/screenShareAudioRestriction");
  return mod.installScreenShareAudioRestriction;
}

interface FakeAudioTrack {
  kind: "audio";
  label: string;
  getSettings(): MediaTrackSettings;
  stop: ReturnType<typeof vi.fn>;
}

function fakeAudioTrack(settings: MediaTrackSettings, label = ""): FakeAudioTrack {
  return { kind: "audio", label, getSettings: () => settings, stop: vi.fn() };
}

/** Just enough MediaStream for the wrapper's post-capture enforcement. */
function fakeStream(tracks: FakeAudioTrack[] = []): MediaStream {
  const live = [...tracks];
  return {
    getAudioTracks: () => live.filter((t) => t.kind === "audio"),
    getVideoTracks: () => [],
    getTracks: () => live,
    removeTrack: (t: FakeAudioTrack) => {
      const i = live.indexOf(t);
      if (i >= 0) live.splice(i, 1);
    },
  } as unknown as MediaStream;
}

/** Stub navigator.mediaDevices with a recording getDisplayMedia (or none). */
function stubMediaDevices(getDisplayMedia?: unknown) {
  const stream = fakeStream();
  const original = getDisplayMedia === undefined
    ? undefined
    : (getDisplayMedia as (c?: DisplayMediaStreamOptions) => Promise<MediaStream>) ??
      vi.fn(async () => stream);
  vi.stubGlobal("navigator", {
    mediaDevices: original ? { getDisplayMedia: original } : {},
  });
  return { stream };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installScreenShareAudioRestriction", () => {
  let calls: Array<DisplayMediaStreamOptions | undefined>;
  let base: (c?: DisplayMediaStreamOptions) => Promise<MediaStream>;

  beforeEach(() => {
    calls = [];
    base = vi.fn(async (c?: DisplayMediaStreamOptions) => {
      calls.push(c);
      return fakeStream();
    });
  });

  it("delivers restrictOwnAudio INSIDE the audio constraints, where the platform reads it", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install();

    await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

    expect(calls).toHaveLength(1);
    const delivered = calls[0]!;
    // Chromium/Electron only honor the flag as a MediaTrackConstraint on the
    // audio track (the sibling of suppressLocalAudioPlayback). A top-level
    // member of the options dictionary is silently dropped, so `audio: true`
    // must be coerced to an object carrying the flag.
    expect(delivered.video).toBe(true);
    const audio = delivered.audio as { restrictOwnAudio?: boolean } | boolean | undefined;
    expect(typeof audio).toBe("object");
    expect((audio as { restrictOwnAudio?: boolean }).restrictOwnAudio).toBe(true);
    // And it must NOT be smuggled in at the top level the platform ignores.
    expect((delivered as { restrictOwnAudio?: boolean }).restrictOwnAudio).toBeUndefined();
  });

  it("merges the flag into existing audio constraints without dropping them", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install();

    await navigator.mediaDevices.getDisplayMedia({
      audio: { echoCancellation: false } as MediaTrackConstraints,
      video: true,
    });

    const audio = calls[0]!.audio as MediaTrackConstraints & { restrictOwnAudio?: boolean };
    expect(audio.echoCancellation).toBe(false);
    expect(audio.restrictOwnAudio).toBe(true);
  });

  it("leaves a video-only capture untouched", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install();

    await navigator.mediaDevices.getDisplayMedia({ video: true });

    // No audio requested, so the constraints pass through verbatim — no audio
    // object is synthesized just to carry the flag.
    expect(calls[0]).toEqual({ video: true });
  });

  it("does not override a caller that set restrictOwnAudio explicitly", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install();

    await navigator.mediaDevices.getDisplayMedia({
      audio: { restrictOwnAudio: false } as MediaTrackConstraints & { restrictOwnAudio?: boolean },
    });

    const audio = calls[0]?.audio as { restrictOwnAudio?: boolean } | undefined;
    expect(audio?.restrictOwnAudio).toBe(false);
  });

  it("is a no-op when getDisplayMedia is unavailable", async () => {
    stubMediaDevices(undefined);
    const install = await freshInstall();
    expect(() => install()).not.toThrow();
    expect(
      (navigator.mediaDevices as MediaDevices).getDisplayMedia,
    ).toBeUndefined();
  });

  it("installs at most once", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install();
    const wrapped = navigator.mediaDevices.getDisplayMedia;
    install();
    // A second install must not wrap the already-wrapped function again.
    expect(navigator.mediaDevices.getDisplayMedia).toBe(wrapped);
  });

  it("scopes window audio and keeps this tab out of the picker on an audio capture", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install();

    await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

    // Both make a capture structurally unable to carry the call.
    expect(calls[0]).toMatchObject({ windowAudio: "window", selfBrowserSurface: "exclude" });
  });

  it("leaves a caller's own windowAudio and selfBrowserSurface alone", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install();

    await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      windowAudio: "system",
      selfBrowserSurface: "include",
    });

    expect(calls[0]).toMatchObject({ windowAudio: "system", selfBrowserSurface: "include" });
  });

  it("strips an audio track the platform did not confirm free of our own playback", async () => {
    // Measured on Chrome/Windows: entire screen, restrictOwnAudio requested
    // and supported, reported back as NOT applied. Publishing it is the echo.
    const echo = fakeAudioTrack({
      displaySurface: "monitor",
      restrictOwnAudio: false,
      deviceId: "loopback",
    });
    stubMediaDevices(vi.fn(async () => fakeStream([echo])));
    const install = await freshInstall();
    install();
    const { consumeOwnAudioDrop } = await import("@/lib/screenShareOwnAudio");

    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

    expect(stream.getAudioTracks()).toHaveLength(0);
    expect(echo.stop).toHaveBeenCalledOnce();
    expect(consumeOwnAudioDrop()).toEqual({
      reason: "unrestrictedLoopback",
      displaySurface: "monitor",
    });
  });

  it("keeps an audio track the platform confirmed clean", async () => {
    const clean = fakeAudioTrack({ deviceId: "loopbackWithoutChrome", restrictOwnAudio: true });
    stubMediaDevices(vi.fn(async () => fakeStream([clean])));
    const install = await freshInstall();
    install();
    const { consumeOwnAudioDrop } = await import("@/lib/screenShareOwnAudio");

    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

    expect(stream.getAudioTracks()).toEqual([clean]);
    expect(clean.stop).not.toHaveBeenCalled();
    expect(consumeOwnAudioDrop()).toBeNull();
  });

  it("asks Chrome to cancel the call's playout out of the display audio on the web", async () => {
    // Chrome refuses restrictOwnAudio below Windows 11; echoCancellation on
    // the display audio is the request Chromium honors there, with this
    // page's peer-connection playout as the canceller's reference.
    stubMediaDevices(base);
    const install = await freshInstall();
    install({ cancelCallPlayout: true });

    await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

    expect(calls[0]!.audio).toMatchObject({ restrictOwnAudio: true, echoCancellation: true });
  });

  it("does not add the canceller on the desktop shell, which excludes its own audio at the device", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install({ cancelCallPlayout: false });

    await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

    const audio = calls[0]!.audio as MediaTrackConstraints;
    expect(audio.restrictOwnAudio).toBe(true);
    expect(audio.echoCancellation).toBeUndefined();
  });

  it("leaves a caller's own echoCancellation decision alone", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install({ cancelCallPlayout: true });

    await navigator.mediaDevices.getDisplayMedia({ audio: { echoCancellation: false } });

    expect((calls[0]!.audio as MediaTrackConstraints).echoCancellation).toBe(false);
  });

  it("keeps a track Chrome confirmed it cancelled the call out of", async () => {
    const cancelled = fakeAudioTrack({
      displaySurface: "monitor",
      restrictOwnAudio: false,
      echoCancellation: true,
    });
    stubMediaDevices(vi.fn(async () => fakeStream([cancelled])));
    const install = await freshInstall();
    install({ cancelCallPlayout: true });
    const { consumeOwnAudioDrop } = await import("@/lib/screenShareOwnAudio");

    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

    expect(stream.getAudioTracks()).toEqual([cancelled]);
    expect(cancelled.stop).not.toHaveBeenCalled();
    expect(consumeOwnAudioDrop()).toBeNull();
  });
});

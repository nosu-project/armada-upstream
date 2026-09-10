import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wrapper carries module-level install state, so each case gets a fresh
// module instance (vi.resetModules + dynamic import) rather than sharing one.
async function freshInstall() {
  vi.resetModules();
  const mod = await import("@/lib/screenShareAudioRestriction");
  return mod.installScreenShareAudioRestriction;
}

/** Stub navigator.mediaDevices with a recording getDisplayMedia (or none). */
function stubMediaDevices(getDisplayMedia?: unknown) {
  const stream = {} as MediaStream;
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
      return {} as MediaStream;
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
});

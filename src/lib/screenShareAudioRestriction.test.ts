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

  it("adds restrictOwnAudio when a capture requests audio", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install();

    await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ audio: true, video: true, restrictOwnAudio: true });
  });

  it("leaves a video-only capture untouched", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install();

    await navigator.mediaDevices.getDisplayMedia({ video: true });

    expect(calls[0]).toEqual({ video: true });
    expect(calls[0]?.restrictOwnAudio).toBeUndefined();
  });

  it("does not override a caller that set restrictOwnAudio explicitly", async () => {
    stubMediaDevices(base);
    const install = await freshInstall();
    install();

    await navigator.mediaDevices.getDisplayMedia({ audio: true, restrictOwnAudio: false });

    expect(calls[0]?.restrictOwnAudio).toBe(false);
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

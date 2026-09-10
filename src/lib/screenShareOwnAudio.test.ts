import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consumeOwnAudioDrop,
  describeOwnAudioDrop,
  enforceOwnAudioExclusion,
  ownAudioVerdict,
} from "@/lib/screenShareOwnAudio";

// The fixtures below are the values MEASURED on real machines — this suite is
// what lets the invariant be checked without a human at a Windows box.
//
//   Chrome 141+ / Windows, entire screen with system audio:
//     getSupportedConstraints().restrictOwnAudio === true, yet the track
//     reported { displaySurface: "monitor", restrictOwnAudio: false }.
//   Chrome 141+ / Windows, a window: no audio track at all.
//   Electron 43.4.0+ (its own api-media-handler spec): a restrictOwnAudio
//     loopback grant yields deviceId "loopbackWithoutChrome",
//     restrictOwnAudio true.
//   Electron < 43.4.0: the same grant yields deviceId "loopback".

interface FakeTrack {
  kind: "audio";
  label: string;
  getSettings(): MediaTrackSettings;
  stop: ReturnType<typeof vi.fn>;
}

function audioTrack(settings: MediaTrackSettings, label = ""): FakeTrack {
  return { kind: "audio", label, getSettings: () => settings, stop: vi.fn() };
}

function stream(tracks: FakeTrack[]): MediaStream & { tracks: FakeTrack[] } {
  const live = [...tracks];
  return {
    tracks: live,
    getAudioTracks: () => live.filter((t) => t.kind === "audio"),
    getVideoTracks: () => [],
    getTracks: () => live,
    removeTrack: (t: FakeTrack) => {
      const i = live.indexOf(t);
      if (i >= 0) live.splice(i, 1);
    },
  } as unknown as MediaStream & { tracks: FakeTrack[] };
}

afterEach(() => {
  consumeOwnAudioDrop();
});

describe("ownAudioVerdict", () => {
  it("refuses a Chrome/Windows entire-screen capture that did not restrict own audio", () => {
    // The measured case: the constraint is supported and was requested, and
    // the platform still reported it as not applied. This is the echo.
    expect(
      ownAudioVerdict({
        settings: { displaySurface: "monitor", restrictOwnAudio: false, deviceId: "loopback" },
        label: "",
        requestedWindowAudio: "window",
      }),
    ).toEqual({ publish: false, reason: "unrestrictedLoopback" });
  });

  it("refuses a monitor capture with no confirmation at all", () => {
    expect(
      ownAudioVerdict({
        settings: { displaySurface: "monitor", restrictOwnAudio: false },
        label: "",
      }),
    ).toEqual({ publish: false, reason: "unconfirmed" });
  });

  it("admits a track the platform confirmed restricted", () => {
    expect(
      ownAudioVerdict({ settings: { displaySurface: "monitor", restrictOwnAudio: true }, label: "" }),
    ).toEqual({ publish: true, basis: "restrictOwnAudio" });
  });

  it("admits Electron's process-excluded loopback (43.4.0+)", () => {
    expect(
      ownAudioVerdict({ settings: { deviceId: "loopbackWithoutChrome" }, label: "" }),
    ).toEqual({ publish: true, basis: "processExcludedLoopback" });
  });

  it("refuses Electron's unrestricted loopback even on a window share", () => {
    // An Electron build before 43.4.0 grants plain loopback whatever the
    // surface; the window-scoping rule must not admit the system mix.
    expect(
      ownAudioVerdict({
        settings: { displaySurface: "window", deviceId: "loopback" },
        label: "",
        requestedWindowAudio: "window",
      }),
    ).toEqual({ publish: false, reason: "unrestrictedLoopback" });
  });

  it("admits venmic's PipeWire microphone, which excludes Armada by pid", () => {
    expect(
      ownAudioVerdict({ settings: { deviceId: "pw-42" }, label: "vencord-screen-share" }),
    ).toEqual({ publish: true, basis: "venmic" });
  });

  it("admits a window share only when window-scoped audio was requested", () => {
    const settings: MediaTrackSettings = { displaySurface: "window", deviceId: "win-audio" };
    expect(ownAudioVerdict({ settings, label: "", requestedWindowAudio: "window" }))
      .toEqual({ publish: true, basis: "windowScoped" });
    // Requested as system audio, or with no request at all: nothing confirms
    // this is the window's own audio rather than the mix.
    expect(ownAudioVerdict({ settings, label: "", requestedWindowAudio: "system" }))
      .toEqual({ publish: false, reason: "unconfirmed" });
    expect(ownAudioVerdict({ settings, label: "" }))
      .toEqual({ publish: false, reason: "unconfirmed" });
  });

  it("admits another tab's audio", () => {
    expect(
      ownAudioVerdict({ settings: { displaySurface: "browser" }, label: "" }),
    ).toEqual({ publish: true, basis: "tabScoped" });
  });
});

describe("enforceOwnAudioExclusion", () => {
  it("stops and removes an unconfirmed track and records the drop", () => {
    const echo = audioTrack({ displaySurface: "monitor", restrictOwnAudio: false, deviceId: "loopback" });
    const s = stream([echo]);

    const dropped = enforceOwnAudioExclusion(s, { windowAudio: "window" });

    expect(dropped).toEqual({ reason: "unrestrictedLoopback", displaySurface: "monitor" });
    expect(echo.stop).toHaveBeenCalledOnce();
    expect(s.getAudioTracks()).toHaveLength(0);
    expect(consumeOwnAudioDrop()).toEqual(dropped);
    // Consumed once.
    expect(consumeOwnAudioDrop()).toBeNull();
  });

  it("leaves a confirmed track in place and records nothing", () => {
    const clean = audioTrack({ deviceId: "loopbackWithoutChrome" });
    const s = stream([clean]);

    expect(enforceOwnAudioExclusion(s)).toBeNull();
    expect(clean.stop).not.toHaveBeenCalled();
    expect(s.getAudioTracks()).toEqual([clean]);
    expect(consumeOwnAudioDrop()).toBeNull();
  });

  it("is a no-op on a capture with no audio (a Windows window share)", () => {
    expect(enforceOwnAudioExclusion(stream([]))).toBeNull();
    expect(consumeOwnAudioDrop()).toBeNull();
  });

  it("clears a previous capture's drop when the next capture is clean", () => {
    enforceOwnAudioExclusion(
      stream([audioTrack({ displaySurface: "monitor", restrictOwnAudio: false })]),
    );
    enforceOwnAudioExclusion(stream([audioTrack({ restrictOwnAudio: true })]));
    expect(consumeOwnAudioDrop()).toBeNull();
  });
});

describe("describeOwnAudioDrop", () => {
  it("tells a full-screen sharer how to get audio", () => {
    const text = describeOwnAudioDrop({ reason: "unrestrictedLoopback", displaySurface: "monitor" });
    expect(text).toMatch(/Full-screen audio/);
    expect(text).toMatch(/echo/);
    expect(text).toMatch(/window or a browser tab/);
  });

  it("does not send a window sharer in circles", () => {
    const text = describeOwnAudioDrop({ reason: "unrestrictedLoopback", displaySurface: "window" });
    expect(text).toMatch(/echo/);
    expect(text).not.toMatch(/Share a window/);
  });
});

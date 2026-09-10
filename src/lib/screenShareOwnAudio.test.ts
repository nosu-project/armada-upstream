import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consumeOwnAudioDrop,
  describeOwnAudioDrop,
  describeOwnAudioState,
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
//   Electron / Windows 10 desktop app, handler granting "loopback": every
//     surface, windows included, came back as deviceId "loopback" — the mix.
//   Electron (its own api-media-handler spec) with the handler granting
//     "loopbackWithoutChrome": deviceId "loopbackWithoutChrome",
//     restrictOwnAudio true. This is what displayMediaPolicy.js now grants.

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
      }),
    ).toEqual({ publish: false, reason: "unrestrictedLoopback" });
  });

  it("admits a Chrome/Windows 10 entire-screen capture once Chrome confirms the call is cancelled out", () => {
    // Chrome refuses restrictOwnAudio below Windows 11, so the web build asks
    // for echoCancellation on the display audio instead; Chromium then runs
    // its canceller against this page's peer-connection playout. The setting
    // is Chrome's confirmation that it did.
    expect(
      ownAudioVerdict({
        settings: {
          displaySurface: "monitor",
          restrictOwnAudio: false,
          echoCancellation: true,
          deviceId: "loopback",
        },
        label: "",
      }),
    ).toEqual({ publish: true, basis: "callPlayoutCancelled" });
  });

  it("still refuses the mix when Chrome declined the canceller", () => {
    expect(
      ownAudioVerdict({
        settings: { displaySurface: "monitor", restrictOwnAudio: false, echoCancellation: false },
        label: "",
      }),
    ).toEqual({ publish: false, reason: "unconfirmed" });
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

  it("admits the process-excluded loopback the desktop shell grants on Windows", () => {
    expect(
      ownAudioVerdict({ settings: { deviceId: "loopbackWithoutChrome" }, label: "" }),
    ).toEqual({ publish: true, basis: "processExcludedLoopback" });
  });

  it("refuses Electron's unrestricted loopback even on a window share", () => {
    // The desktop shell grants plain loopback whatever the surface on a
    // Windows build too old for process loopback; the window-scoping rule must
    // not admit the system mix.
    expect(
      ownAudioVerdict({
        settings: { displaySurface: "window", deviceId: "loopback" },
        label: "",
      }),
    ).toEqual({ publish: false, reason: "unrestrictedLoopback" });
  });

  it("admits venmic's PipeWire microphone, which excludes Armada by pid", () => {
    expect(
      ownAudioVerdict({ settings: { deviceId: "pw-42" }, label: "vencord-screen-share" }),
    ).toEqual({ publish: true, basis: "venmic" });
  });

  it("does not admit a window share on the strength of having asked for window audio", () => {
    // Measured on Chrome/Windows 10: a window share requested with
    // windowAudio:"window" came back carrying the system mix, call included —
    // Chrome cannot scope audio to a window below Windows 11 and says nothing.
    // A request is not a confirmation; only a confirmed signal admits it.
    const settings: MediaTrackSettings = { displaySurface: "window", deviceId: "win-audio" };
    expect(ownAudioVerdict({ settings, label: "" }))
      .toEqual({ publish: false, reason: "unconfirmed" });
    expect(ownAudioVerdict({ settings: { ...settings, echoCancellation: true }, label: "" }))
      .toEqual({ publish: true, basis: "callPlayoutCancelled" });
    expect(ownAudioVerdict({ settings: { ...settings, restrictOwnAudio: true }, label: "" }))
      .toEqual({ publish: true, basis: "restrictOwnAudio" });
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

    const dropped = enforceOwnAudioExclusion(s);

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

describe("describeOwnAudioState", () => {
  it("names the basis a live audio track was admitted on", () => {
    const track = audioTrack({ deviceId: "loopbackWithoutChrome" }) as unknown as MediaStreamTrack;
    expect(describeOwnAudioState(track)).toBe("System audio, this app excluded at the device");
    const cancelled = audioTrack({ echoCancellation: true }) as unknown as MediaStreamTrack;
    expect(describeOwnAudioState(cancelled)).toBe("System audio, the call cancelled out by the browser");
  });

  it("explains the most recent drop when no audio is going out", () => {
    enforceOwnAudioExclusion(
      stream([audioTrack({ displaySurface: "window", restrictOwnAudio: false })]),
    );
    expect(describeOwnAudioState(undefined)).toMatch(/^Left out: the browser did not confirm/);
    // Peeking does not consume the record; the toast still gets it.
    expect(consumeOwnAudioDrop()).not.toBeNull();
    expect(describeOwnAudioState(undefined)).toBe("Not captured");
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

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Room } from "livekit-client";

import { supportsSpeakerSelection } from "@/lib/voiceDevices";

/**
 * Proof tests for the interaction between the app's "can the user pick a
 * speaker?" gate and LiveKit's `webAudioMix` playback path (enabled by the
 * screen-share/volume PR).
 *
 * The app shows the Speaker selector iff `"setSinkId" in HTMLMediaElement.prototype`
 * (see `supportsSpeakerSelection` in VoiceBar.tsx / VoiceDeviceSettings.tsx).
 * But with `webAudioMix: true`, LiveKit routes remote audio through an
 * `AudioContext`, so `switchActiveDevice("audiooutput", …)` instead requires
 * `AudioContext.prototype.setSinkId` — a much narrower capability (Chromium 110+
 * only; absent in Firefox/Safari where `HTMLMediaElement.setSinkId` may still
 * exist). Where the two diverge, the menu is shown but switching throws.
 */
describe("webAudioMix audio-output switching vs the app's speaker gate", () => {
  afterEach(() => {
    // Restore any capability shims we defined on the prototypes.
    delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).setSinkId;
  });

  /** The exact predicate the app uses to decide whether to show the Speaker menu. */
  const appSaysSpeakerSelectable = () =>
    typeof document !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  it("throws on output switch under webAudioMix when AudioContext lacks setSinkId, even though the app gate reports 'supported'", async () => {
    // Firefox-like engine: media elements support setSinkId (so the app shows
    // the Speaker menu) but the AudioContext does not.
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      value: () => Promise.resolve(),
      configurable: true,
    });
    expect(appSaysSpeakerSelectable()).toBe(true);

    const room = new Room({ webAudioMix: true });
    // Stand in for the context LiveKit acquires on connect; no setSinkId.
    (room as unknown as { audioContext: unknown }).audioContext = { state: "running" };

    await expect(
      room.switchActiveDevice("audiooutput", "some-speaker-id"),
    ).rejects.toThrow(/does not support/i);
  });

  it("does NOT throw the unsupported error when the AudioContext has setSinkId", async () => {
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      value: () => Promise.resolve(),
      configurable: true,
    });

    const room = new Room({ webAudioMix: true });
    (room as unknown as { audioContext: unknown }).audioContext = {
      state: "running",
      setSinkId: () => Promise.resolve(),
    };

    // It may still reject later (device enumeration in jsdom), but never with
    // the "browser does not support it" capability error.
    const err = await room
      .switchActiveDevice("audiooutput", "some-speaker-id")
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(String(err ?? "")).not.toMatch(/does not support/i);
  });
});

/**
 * The app-facing fix: `supportsSpeakerSelection()` must match what actually
 * works under `webAudioMix` — i.e. gate on `AudioContext.setSinkId`, not the
 * media element — so the Speaker menu is hidden exactly where switching would
 * throw (above).
 */
describe("supportsSpeakerSelection()", () => {
  const g = globalThis as unknown as { AudioContext?: unknown };
  const originalAudioContext = g.AudioContext;

  afterEach(() => {
    if (originalAudioContext === undefined) delete g.AudioContext;
    else g.AudioContext = originalAudioContext;
    delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).setSinkId;
  });

  it("is false when the AudioContext cannot switch sinks, even if the media element can", () => {
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      value: () => Promise.resolve(),
      configurable: true,
    });
    class FirefoxLikeAudioContext {}
    g.AudioContext = FirefoxLikeAudioContext;

    expect(supportsSpeakerSelection()).toBe(false);
  });

  it("is true when the AudioContext supports setSinkId (Chromium 110+)", () => {
    class ChromeLikeAudioContext {
      setSinkId() {
        return Promise.resolve();
      }
    }
    g.AudioContext = ChromeLikeAudioContext;

    expect(supportsSpeakerSelection()).toBe(true);
  });

  it("is false when there is no AudioContext at all", () => {
    delete g.AudioContext;
    expect(supportsSpeakerSelection()).toBe(false);
  });
});

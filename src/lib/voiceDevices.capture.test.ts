import { describe, expect, it } from "vitest";

import { micCaptureConstraints } from "./voiceDevices";

const allOn = { noiseSuppression: true, echoCancellation: true, autoGainControl: true, rnnoise: false };

describe("micCaptureConstraints", () => {
  it("captures MONO whatever the processing prefs say", () => {
    // A stereo interface that populates one channel otherwise publishes a
    // track every listener hears in one ear. This is the regression the
    // Aug 12 "one ear" fix closed and nothing else asserts.
    expect(micCaptureConstraints(allOn, null).channelCount).toBe(1);
    expect(micCaptureConstraints({ ...allOn, echoCancellation: false, noiseSuppression: false }, null).channelCount).toBe(1);
  });

  it("carries the user's processing prefs through unchanged", () => {
    const c = micCaptureConstraints({ noiseSuppression: false, echoCancellation: true, autoGainControl: false, rnnoise: true }, null);
    expect(c).toMatchObject({ noiseSuppression: false, echoCancellation: true, autoGainControl: false });
    // rnnoise is a track processor, not a browser constraint: it must not leak in.
    expect("rnnoise" in c).toBe(false);
  });

  it("names the preferred mic only when one is remembered", () => {
    expect(micCaptureConstraints(allOn, "mic-1").deviceId).toBe("mic-1");
    expect("deviceId" in micCaptureConstraints(allOn, null)).toBe(false);
  });
});

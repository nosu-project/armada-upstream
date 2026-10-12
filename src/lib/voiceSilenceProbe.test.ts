import { afterEach, describe, expect, it } from "vitest";
import { LocalAudioTrack } from "livekit-client";

import { guardSilenceProbe } from "@/lib/voiceAudioContext";

const g = globalThis as unknown as { AnalyserNode?: unknown };
const originalProbe = LocalAudioTrack.prototype.checkForSilence;

afterEach(() => {
  LocalAudioTrack.prototype.checkForSilence = originalProbe;
  delete g.AnalyserNode;
});

describe("guardSilenceProbe()", () => {
  it("replaces the probe where AnalyserNode reads are stripped", async () => {
    g.AnalyserNode = class {};
    guardSilenceProbe();
    expect(LocalAudioTrack.prototype.checkForSilence).not.toBe(originalProbe);
    await expect(LocalAudioTrack.prototype.checkForSilence.call({} as LocalAudioTrack)).resolves.toBe(false);
  });

  it("keeps LiveKit's probe where AnalyserNode is readable", () => {
    g.AnalyserNode = class {
      getByteTimeDomainData() {}
    };
    guardSilenceProbe();
    expect(LocalAudioTrack.prototype.checkForSilence).toBe(originalProbe);
  });
});

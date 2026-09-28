import { describe, expect, it } from "vitest";

import { waveformFromChannels } from "./audioWaveform";

describe("waveformFromChannels", () => {
  it("scales RMS per bucket so the loudest is 100", () => {
    const quiet = new Float32Array(100).fill(0.1);
    const loud = new Float32Array(100).fill(0.4);
    const silent = new Float32Array(100);
    const channel = new Float32Array([...quiet, ...loud, ...silent]);
    expect(waveformFromChannels([channel], 3)).toEqual([25, 100, 0]);
  });

  it("averages over every channel", () => {
    const left = new Float32Array([1, 1, 0, 0]);
    const right = new Float32Array([0, 0, 0, 0]);
    expect(waveformFromChannels([left, right], 2)).toEqual([100, 0]);
  });

  it("gives no more points than there are samples, and none for no audio", () => {
    expect(waveformFromChannels([new Float32Array([0.5, 0.5])], 100)).toHaveLength(2);
    expect(waveformFromChannels([new Float32Array(0)])).toEqual([]);
    expect(waveformFromChannels([])).toEqual([]);
  });

  it("is flat zero for pure silence rather than dividing by it", () => {
    expect(waveformFromChannels([new Float32Array(10)], 5)).toEqual([0, 0, 0, 0, 0]);
  });
});

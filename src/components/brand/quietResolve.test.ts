import { describe, expect, it } from "vitest";

import { buildScore, renderQuietResolveLoop, SAMPLE_RATE } from "./quietResolve";

describe("Quiet Resolve", () => {
  it("fills every bar of the melody", () => {
    const { lead, arp } = buildScore();
    const end = lead.at(-1)!;
    expect(end[0] + end[1]).toBe(32 * 6);
    expect(arp).toHaveLength(32 * 6);
  });

  it("renders exactly 32 bars at 115 BPM, peaking at 0.77", () => {
    const samples = renderQuietResolveLoop();
    expect(samples.length).toBe(Math.round(32 * 3 * (60 / 115) * SAMPLE_RATE));
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeCloseTo(0.77, 5);
  }, 30_000);
});

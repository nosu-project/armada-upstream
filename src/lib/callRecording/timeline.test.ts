import { describe, expect, it } from "vitest";

import { TrackTimeline } from "./timeline";

const frames = (n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => from + i);

describe("TrackTimeline", () => {
  it("pads a late start with the silence it missed", () => {
    const t = new TrackTimeline();
    const placed = t.place(480, frames(128));
    expect(placed.silence).toBe(480);
    expect(placed.samples.length).toBe(128);
    expect(t.written).toBe(608);
  });

  it("writes contiguous audio without padding", () => {
    const t = new TrackTimeline();
    t.place(0, frames(128));
    expect(t.place(128, frames(128)).silence).toBe(0);
    expect(t.written).toBe(256);
  });

  it("fills a gap (a dropped or rejoined track) with silence", () => {
    const t = new TrackTimeline();
    t.place(0, frames(100));
    expect(t.place(1100, frames(10)).silence).toBe(1000);
  });

  it("drops audio the file already covers and keeps only the new tail", () => {
    const t = new TrackTimeline();
    t.place(0, frames(100));
    const placed = t.place(60, frames(80, 60));
    expect(placed.silence).toBe(0);
    expect(Array.from(placed.samples)).toEqual(Array.from(frames(40, 100)));
    expect(t.place(0, frames(50)).samples.length).toBe(0);
    expect(t.written).toBe(140);
  });

  it("drops audio from before the recording started", () => {
    const t = new TrackTimeline();
    const placed = t.place(-64, frames(128, -64));
    expect(placed.samples[0]).toBe(0);
    expect(placed.samples.length).toBe(64);
  });

  it("pads to the recording's end so every file has the same length", () => {
    const t = new TrackTimeline();
    t.place(0, frames(100));
    expect(t.padTo(250)).toBe(150);
    expect(t.padTo(250)).toBe(0);
    expect(t.written).toBe(250);
  });
});

import { describe, expect, it } from "vitest";

import {
  AUDIO_BITRATE,
  averageBitrate,
  decideVideoAction,
  isFastStartMp4,
  MAX_INPUT_BYTES,
  MAX_REMUX_BYTES,
  MIN_VIDEO_BITRATE,
  roundTo16,
  scaleToFit,
  targetVideoBitrate,
  VIDEO_BITRATE,
  type ByteReader,
  type VideoProbe,
} from "./policy";

/** A source that needs nothing done to it: 720p H.264 MP4 at ~1.5 Mbps. */
function compliantProbe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    size: 11_250_000, // 60s at ~1.5 Mbps
    duration: 60,
    width: 1280,
    height: 720,
    codec: "avc",
    mimeType: "video/mp4",
    canEncode: true,
    isFastStart: true,
    hasMetadataTags: false,
    ...overrides,
  };
}

describe("roundTo16", () => {
  it("rounds to the nearest multiple of 16", () => {
    expect(roundTo16(720)).toBe(720);
    expect(roundTo16(1080)).toBe(1088);
    expect(roundTo16(540)).toBe(544);
    expect(roundTo16(537)).toBe(544);
    expect(roundTo16(535)).toBe(528);
  });

  it("never returns less than 16", () => {
    expect(roundTo16(0)).toBe(16);
    expect(roundTo16(1)).toBe(16);
    expect(roundTo16(-100)).toBe(16);
  });
});

describe("scaleToFit", () => {
  it("maps common landscape sources onto exact 16-multiples", () => {
    expect(scaleToFit(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(scaleToFit(3840, 2160)).toEqual({ width: 1280, height: 720 });
  });

  it("preserves orientation for portrait video", () => {
    expect(scaleToFit(1080, 1920)).toEqual({ width: 720, height: 1280 });
  });

  it("constrains 4:3 by the short edge", () => {
    expect(scaleToFit(4000, 3000)).toEqual({ width: 960, height: 720 });
  });

  it("constrains ultrawide by the long edge", () => {
    // 2560x1080 scales by 0.5; 540 rounds up to the nearest 16.
    expect(scaleToFit(2560, 1080)).toEqual({ width: 1280, height: 544 });
  });

  it("never upscales", () => {
    expect(scaleToFit(640, 480)).toEqual({ width: 640, height: 480 });
    expect(scaleToFit(320, 240)).toEqual({ width: 320, height: 240 });
  });
});

describe("targetVideoBitrate", () => {
  it("gives the full budget at the reference resolution", () => {
    expect(targetVideoBitrate(1280, 720)).toBe(VIDEO_BITRATE);
  });

  it("scales down with pixel count", () => {
    expect(targetVideoBitrate(640, 360)).toBe(VIDEO_BITRATE / 4);
  });

  it("clamps to the floor for tiny videos", () => {
    expect(targetVideoBitrate(160, 120)).toBe(MIN_VIDEO_BITRATE);
  });

  it("never exceeds the reference budget", () => {
    expect(targetVideoBitrate(1920, 1080)).toBe(VIDEO_BITRATE);
  });
});

describe("averageBitrate", () => {
  it("computes bits per second", () => {
    expect(averageBitrate(1_000_000, 8)).toBe(1_000_000);
  });

  it("returns null when duration or size is unusable", () => {
    expect(averageBitrate(1_000_000, 0)).toBeNull();
    expect(averageBitrate(0, 10)).toBeNull();
  });
});

describe("decideVideoAction", () => {
  it("passes through a file that is already optimal", () => {
    expect(decideVideoAction(compliantProbe())).toEqual({
      kind: "passthrough",
      reason: "already-optimal",
    });
  });

  it("remuxes a compliant file that carries metadata tags", () => {
    // Stripping GPS/creation date is the whole point of this path.
    expect(decideVideoAction(compliantProbe({ hasMetadataTags: true })))
      .toEqual({ kind: "remux" });
  });

  it("remuxes a compliant file that is not fast-start", () => {
    expect(decideVideoAction(compliantProbe({ isFastStart: false })))
      .toEqual({ kind: "remux" });
  });

  it("transcodes when the source is over the resolution cap", () => {
    const action = decideVideoAction(compliantProbe({ width: 3840, height: 2160 }));
    expect(action).toEqual({
      kind: "transcode",
      width: 1280,
      height: 720,
      videoBitrate: VIDEO_BITRATE,
      audioBitrate: AUDIO_BITRATE,
    });
  });

  it("transcodes when the source bitrate is well over target", () => {
    // 60s at ~8 Mbps, well past the 1.2x tolerance on 2 Mbps + 128 kbps.
    const action = decideVideoAction(compliantProbe({ size: 60_000_000 }));
    expect(action).toMatchObject({ kind: "transcode" });
  });

  it("tolerates a source slightly over target rather than re-encoding", () => {
    // 2.4 Mbps total sits just inside 1.2 x (2 Mbps + 128 kbps).
    const size = ((VIDEO_BITRATE + AUDIO_BITRATE) * 1.15 * 60) / 8;
    expect(decideVideoAction(compliantProbe({ size, hasMetadataTags: true })))
      .toEqual({ kind: "remux" });
  });

  it("transcodes a non-H.264 source even when small", () => {
    const action = decideVideoAction(compliantProbe({ codec: "vp9", mimeType: "video/webm" }));
    expect(action).toMatchObject({ kind: "transcode" });
  });

  it("transcodes H.264 in a container we cannot remux", () => {
    const action = decideVideoAction(compliantProbe({ mimeType: "video/x-matroska" }));
    expect(action).toMatchObject({ kind: "transcode" });
  });

  it("accepts QuickTime as remuxable", () => {
    expect(decideVideoAction(compliantProbe({ mimeType: "video/quicktime", hasMetadataTags: true })))
      .toEqual({ kind: "remux" });
  });

  it("passes through input past the hard size cap", () => {
    const probe = compliantProbe({ size: MAX_INPUT_BYTES + 1, width: 3840, height: 2160 });
    expect(decideVideoAction(probe)).toEqual({ kind: "passthrough", reason: "too-large" });
  });

  it("skips the remux for a compliant file too large to buffer", () => {
    // Compliant on every axis but past the remux ceiling: not worth the memory.
    const probe = compliantProbe({
      size: MAX_REMUX_BYTES + 1,
      duration: 3000, // keeps the average bitrate under target
      hasMetadataTags: true,
    });
    expect(decideVideoAction(probe)).toEqual({ kind: "passthrough", reason: "too-large" });
  });

  it("passes through when no encoder is available", () => {
    const probe = compliantProbe({ width: 3840, height: 2160, canEncode: false });
    expect(decideVideoAction(probe)).toEqual({ kind: "passthrough", reason: "no-encoder" });
  });

  it("still remuxes without an encoder, since no encoding is involved", () => {
    const probe = compliantProbe({ canEncode: false, hasMetadataTags: true });
    expect(decideVideoAction(probe)).toEqual({ kind: "remux" });
  });

  it("passes through unreadable dimensions", () => {
    expect(decideVideoAction(compliantProbe({ width: 0, height: 0 })))
      .toEqual({ kind: "passthrough", reason: "unreadable" });
  });

  it("transcodes when duration is unknown, since bitrate cannot be judged", () => {
    const action = decideVideoAction(compliantProbe({ duration: 0 }));
    expect(action).toMatchObject({ kind: "transcode" });
  });
});

describe("isFastStartMp4", () => {
  /** Builds a reader over a synthetic list of top-level boxes. */
  function boxFile(boxes: { type: string; size: number }[]): { read: ByteReader; size: number } {
    const total = boxes.reduce((n, b) => n + b.size, 0);
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    for (const box of boxes) {
      view.setUint32(offset, box.size);
      for (let i = 0; i < 4; i++) bytes[offset + 4 + i] = box.type.charCodeAt(i);
      offset += box.size;
    }
    return {
      size: total,
      read: async (at, length) => bytes.subarray(at, Math.min(at + length, total)),
    };
  }

  it("detects moov before mdat", async () => {
    const { read, size } = boxFile([
      { type: "ftyp", size: 32 },
      { type: "moov", size: 1024 },
      { type: "mdat", size: 4096 },
    ]);
    await expect(isFastStartMp4(read, size)).resolves.toBe(true);
  });

  it("detects mdat before moov", async () => {
    const { read, size } = boxFile([
      { type: "ftyp", size: 32 },
      { type: "mdat", size: 4096 },
      { type: "moov", size: 1024 },
    ]);
    await expect(isFastStartMp4(read, size)).resolves.toBe(false);
  });

  it("skips over intermediate boxes", async () => {
    const { read, size } = boxFile([
      { type: "ftyp", size: 32 },
      { type: "free", size: 64 },
      { type: "uuid", size: 128 },
      { type: "moov", size: 512 },
    ]);
    await expect(isFastStartMp4(read, size)).resolves.toBe(true);
  });

  it("returns false for a file with neither box", async () => {
    const { read, size } = boxFile([{ type: "ftyp", size: 32 }]);
    await expect(isFastStartMp4(read, size)).resolves.toBe(false);
  });

  it("returns false rather than looping on a zero-length box", async () => {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0); // size 0 = "extends to end of file"
    for (let i = 0; i < 4; i++) bytes[4 + i] = "free".charCodeAt(i);
    const read: ByteReader = async (at, len) => bytes.subarray(at, Math.min(at + len, 64));
    await expect(isFastStartMp4(read, 64)).resolves.toBe(false);
  });

  it("returns false for a truncated header", async () => {
    const bytes = new Uint8Array(4);
    const read: ByteReader = async (at, len) => bytes.subarray(at, Math.min(at + len, 4));
    await expect(isFastStartMp4(read, 4)).resolves.toBe(false);
  });

  it("returns false for a nonsensically small box size", async () => {
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 4); // smaller than the 8-byte header
    for (let i = 0; i < 4; i++) bytes[4 + i] = "free".charCodeAt(i);
    const read: ByteReader = async (at, len) => bytes.subarray(at, Math.min(at + len, 32));
    await expect(isFastStartMp4(read, 32)).resolves.toBe(false);
  });
});

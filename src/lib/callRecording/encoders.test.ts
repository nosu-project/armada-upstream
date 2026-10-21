import { describe, expect, it } from "vitest";

import { AuEncoder } from "./au";
import type { Encoder } from "./encoder";
import { FlacEncoder, utf8Number } from "./flac";
import { WavEncoder } from "./wav";

/** Run an encoder the way the worker does: append, then apply the patches. */
async function render(enc: Encoder, chunks: Float32Array[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [...(await enc.start())];
  for (const chunk of chunks) parts.push(...(await enc.write(chunk)));
  const { tail, patches } = await enc.finish();
  parts.push(...tail);
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  for (const patch of patches) out.set(patch.bytes, patch.at);
  return out;
}

const tone = (n: number) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(i / 7));
const ascii = (bytes: Uint8Array, at: number, len: number) => String.fromCharCode(...bytes.subarray(at, at + len));

describe("WavEncoder", () => {
  it("writes 24-bit mono PCM with the final lengths patched in", async () => {
    const bytes = await render(new WavEncoder({ sampleRate: 48_000, title: "x" }), [tone(5), tone(4)]);
    const view = new DataView(bytes.buffer);
    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(27);
    // Odd data length gets RIFF's pad byte, which the RIFF size counts.
    expect(bytes.length).toBe(44 + 27 + 1);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
  });

  it("clamps out-of-range samples instead of wrapping", async () => {
    const bytes = await render(new WavEncoder({ sampleRate: 48_000, title: "x" }), [Float32Array.of(2, -2)]);
    expect(Array.from(bytes.subarray(44, 50))).toEqual([0xff, 0xff, 0x7f, 0x01, 0x00, 0x80]);
  });
});

describe("AuEncoder", () => {
  it("writes big-endian float with the length patched in", async () => {
    const bytes = await render(new AuEncoder({ sampleRate: 48_000, title: "x" }), [Float32Array.of(0.25, -1)]);
    const view = new DataView(bytes.buffer);
    expect(ascii(bytes, 0, 4)).toBe(".snd");
    expect(view.getUint32(8, false)).toBe(8);
    expect(view.getUint32(12, false)).toBe(6);
    expect(view.getFloat32(24, false)).toBe(0.25);
    expect(view.getFloat32(28, false)).toBe(-1);
  });
});

describe("FlacEncoder", () => {
  it("records the total samples, title and frame sizes in its metadata", async () => {
    const bytes = await render(new FlacEncoder({ sampleRate: 48_000, title: "Ana" }), [tone(10_000)]);
    expect(ascii(bytes, 0, 4)).toBe("fLaC");
    const info = bytes.subarray(8, 42);
    // 20-bit sample rate, then channels-1 (3 bits) and bps-1 (5 bits).
    expect((info[10] << 12) | (info[11] << 4) | (info[12] >> 4)).toBe(48_000);
    expect(((info[12] & 1) << 4) | (info[13] >> 4)).toBe(23);
    const total = (info[13] & 0xf) * 2 ** 32 + new DataView(info.buffer, info.byteOffset + 14, 4).getUint32(0);
    expect(total).toBe(10_000);
    expect(new TextDecoder().decode(bytes)).toContain("TITLE=Ana");
    // First frame starts with the fixed-blocksize sync code.
    const firstFrame = 4 + 4 + 34 + 4 + (bytes[43] << 16 | bytes[44] << 8 | bytes[45]);
    expect([bytes[firstFrame], bytes[firstFrame + 1]]).toEqual([0xff, 0xf8]);
  });

  it("stores silence as constant subframes", async () => {
    const silent = await render(new FlacEncoder({ sampleRate: 48_000, title: "" }), [new Float32Array(48_000)]);
    const loud = await render(new FlacEncoder({ sampleRate: 48_000, title: "" }), [tone(48_000)]);
    expect(silent.length).toBeLessThan(500);
    expect(loud.length).toBeGreaterThan(silent.length * 10);
  });

  it("codes frame numbers the way FLAC's UTF-8-like scheme does", () => {
    expect(utf8Number(0)).toEqual([0]);
    expect(utf8Number(0x7f)).toEqual([0x7f]);
    expect(utf8Number(0x80)).toEqual([0xc2, 0x80]);
    expect(utf8Number(0x7ff)).toEqual([0xdf, 0xbf]);
    expect(utf8Number(0x800)).toEqual([0xe0, 0xa0, 0x80]);
    expect(utf8Number(0xffff)).toEqual([0xef, 0xbf, 0xbf]);
    expect(utf8Number(0x10000)).toEqual([0xf0, 0x90, 0x80, 0x80]);
  });
});

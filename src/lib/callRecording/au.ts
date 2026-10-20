import type { Encoder, EncoderOptions, EncoderTail } from "@/lib/callRecording/encoder";

const HEADER_BYTES = 24;
/** AU's "length unknown", which readers accept — so a crashed take is still playable. */
const UNKNOWN = 0xffff_ffff;

/** Sun/NeXT AU, 32-bit float, big-endian — Mumble's other uncompressed format. */
export class AuEncoder implements Encoder {
  private dataBytes = 0;

  constructor(private readonly opts: EncoderOptions) {}

  start(): Uint8Array[] {
    return [header(this.opts.sampleRate, UNKNOWN)];
  }

  write(samples: Float32Array): Uint8Array[] {
    const out = new Uint8Array(samples.length * 4);
    const view = new DataView(out.buffer);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      view.setFloat32(i * 4, s > 1 ? 1 : s < -1 ? -1 : s || 0, false);
    }
    this.dataBytes += out.length;
    return [out];
  }

  finish(): EncoderTail {
    const size = this.dataBytes < UNKNOWN ? this.dataBytes : UNKNOWN;
    return { tail: [], patches: [{ at: 0, bytes: header(this.opts.sampleRate, size) }] };
  }
}

function header(sampleRate: number, dataBytes: number): Uint8Array {
  const buf = new Uint8Array(HEADER_BYTES);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x2e736e64, false); // ".snd"
  view.setUint32(4, HEADER_BYTES, false);
  view.setUint32(8, dataBytes, false);
  view.setUint32(12, 6, false); // 32-bit IEEE float
  view.setUint32(16, sampleRate, false);
  view.setUint32(20, 1, false);
  return buf;
}

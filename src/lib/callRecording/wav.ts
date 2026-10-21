import { toInt24, type Encoder, type EncoderOptions, type EncoderTail } from "@/lib/callRecording/encoder";

const HEADER_BYTES = 44;
/** RIFF sizes are 32-bit; past this (~8 h of 24-bit mono at 48 kHz) the header saturates. */
const MAX_DATA_BYTES = 0xffff_ffff - (HEADER_BYTES - 8);

/** 24-bit PCM WAV, as Mumble writes. */
export class WavEncoder implements Encoder {
  private dataBytes = 0;

  constructor(private readonly opts: EncoderOptions) {}

  start(): Uint8Array[] {
    return [header(this.opts.sampleRate, 0)];
  }

  write(samples: Float32Array): Uint8Array[] {
    const out = new Uint8Array(samples.length * 3);
    for (let i = 0, o = 0; i < samples.length; i++, o += 3) {
      const v = toInt24(samples[i]);
      out[o] = v & 0xff;
      out[o + 1] = (v >> 8) & 0xff;
      out[o + 2] = (v >> 16) & 0xff;
    }
    this.dataBytes += out.length;
    return [out];
  }

  finish(): EncoderTail {
    const pad = this.dataBytes % 2 ? [new Uint8Array(1)] : [];
    return { tail: pad, patches: [{ at: 0, bytes: header(this.opts.sampleRate, this.dataBytes) }] };
  }
}

function header(sampleRate: number, dataBytes: number): Uint8Array {
  const data = Math.min(dataBytes, MAX_DATA_BYTES);
  const buf = new Uint8Array(HEADER_BYTES);
  const view = new DataView(buf.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, Math.min(0xffff_ffff, HEADER_BYTES - 8 + data + (data % 2)), true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 3, true);
  view.setUint16(32, 3, true);
  view.setUint16(34, 24, true);
  ascii(36, "data");
  view.setUint32(40, data, true);
  return buf;
}

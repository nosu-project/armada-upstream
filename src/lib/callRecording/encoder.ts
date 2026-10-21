/**
 * A streaming mono encoder. Bytes are appended to the file in order; `finish`
 * may also rewrite earlier bytes (a header's lengths), which is why the file
 * is staged where it can be written at an offset (OPFS) rather than streamed.
 */
export interface Encoder {
  /** Bytes the file begins with. */
  start(): Promise<Uint8Array[]> | Uint8Array[];
  /** Encode the next samples, in [-1, 1]. */
  write(samples: Float32Array): Promise<Uint8Array[]> | Uint8Array[];
  finish(): Promise<EncoderTail> | EncoderTail;
}

export interface EncoderTail {
  /** Bytes to append. */
  tail: Uint8Array[];
  /** Bytes to overwrite once everything is appended. */
  patches: { at: number; bytes: Uint8Array }[];
}

export interface EncoderOptions {
  sampleRate: number;
  /** Stored as the file's title where the format has one (Mumble does the same). */
  title: string;
}

export const INT24_MAX = 8_388_607;

/** Float sample to a clamped signed 24-bit integer. */
export function toInt24(sample: number): number {
  const s = sample > 1 ? 1 : sample < -1 ? -1 : sample || 0;
  return Math.round(s * INT24_MAX);
}

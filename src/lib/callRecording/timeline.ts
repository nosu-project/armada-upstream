/**
 * Keeps one recorded voice on the recording's clock (Mumble's
 * `lastWrittenAbsoluteSample`): audio that arrives after a gap — a late join,
 * a dropped track, a rejoin — is preceded by the silence it missed, and audio
 * the file already covers is dropped. Every voice's file therefore starts at
 * the recording's start and lines up sample-for-sample with the others.
 */
export class TrackTimeline {
  /** Frames written so far, relative to the recording's start. */
  written = 0;

  /**
   * Place `samples`, which begin `offset` frames after the recording's start.
   * Returns the silence to write first and the part of `samples` still new.
   */
  place(offset: number, samples: Float32Array): { silence: number; samples: Float32Array } {
    const end = offset + samples.length;
    if (end <= this.written) return { silence: 0, samples: samples.subarray(0, 0) };
    const skip = Math.max(0, this.written - offset);
    const silence = Math.max(0, offset - this.written);
    this.written = end;
    return { silence, samples: skip > 0 ? samples.subarray(skip) : samples };
  }

  /** Silence needed to reach `frames` (the recording's end). */
  padTo(frames: number): number {
    const silence = Math.max(0, frames - this.written);
    this.written += silence;
    return silence;
  }
}

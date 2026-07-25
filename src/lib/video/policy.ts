/**
 * Pure decision logic for the outgoing-video pipeline.
 *
 * Deliberately free of any `mediabunny` / WebCodecs import so it can be unit
 * tested under jsdom (which has no WebCodecs). The worker in `./worker.ts`
 * probes a file, hands the resulting {@link VideoProbe} to
 * {@link decideVideoAction}, and executes whatever comes back.
 */

/** Maximum short edge (height for landscape) of a transcoded video. */
export const MAX_SHORT_EDGE = 720;

/** Maximum long edge (width for landscape) of a transcoded video. */
export const MAX_LONG_EDGE = 1280;

/** Target video bitrate at {@link MAX_LONG_EDGE}x{@link MAX_SHORT_EDGE}. */
export const VIDEO_BITRATE = 2_000_000;

/** Floor for the resolution-scaled video bitrate, so tiny clips stay watchable. */
export const MIN_VIDEO_BITRATE = 400_000;

/** Target audio bitrate when the audio track has to be re-encoded. */
export const AUDIO_BITRATE = 128_000;

/** Maximum seconds between key frames in a transcoded video. */
export const KEYFRAME_INTERVAL = 2;

/**
 * Above this input size we upload the original untouched. Both processing
 * paths buffer the output in memory (`fastStart: 'in-memory'`), and on the
 * transcode path we only control the output size, not the peak cost of getting
 * there. Refusing to start is better than an OOM that loses the message.
 */
export const MAX_INPUT_BYTES = 500 * 1024 * 1024;

/**
 * Above this input size we skip the remux-only path. A remux copies packets
 * verbatim, so its output is roughly the input size and sits in memory until
 * finalize; a full transcode's output is bounded by our own bitrate target and
 * is therefore safe well past this.
 */
export const MAX_REMUX_BYTES = 100 * 1024 * 1024;

/**
 * How far over the target total bitrate a source may sit before we re-encode
 * it. Most modern phone video is already H.264 at a sane bitrate, and a
 * needless re-encode costs generation loss plus tens of seconds of CPU.
 */
export const BITRATE_TOLERANCE = 1.2;

/** Container MIME types we can remux in place (ISOBMFF family). */
const REMUXABLE_MIME = /^video\/(mp4|quicktime|x-m4v)$/i;

/** What the worker should do with a video file. */
export type VideoAction =
  | {
    /** Upload the original bytes untouched. */
    kind: "passthrough";
    reason: "too-large" | "no-encoder" | "unreadable" | "already-optimal";
  }
  | {
    /**
     * Copy packets into a fresh MP4 without re-encoding: strips metadata
     * tags (creation date, GPS) and relocates `moov` to the front for
     * streaming playback, at a fraction of a transcode's cost.
     */
    kind: "remux";
  }
  | {
    /** Full decode/encode to the given dimensions and bitrates. */
    kind: "transcode";
    width: number;
    height: number;
    videoBitrate: number;
    audioBitrate: number;
  };

/** Everything {@link decideVideoAction} needs to know about a source file. */
export interface VideoProbe {
  /** Source file size in bytes. */
  size: number;
  /** Duration in seconds. Zero/unknown disables the bitrate heuristic. */
  duration: number;
  /** Rotation-corrected display width in pixels. */
  width: number;
  /** Rotation-corrected display height in pixels. */
  height: number;
  /** Video codec as reported by mediabunny, e.g. `"avc"`. */
  codec: string | null;
  /** MIME type of the source container. */
  mimeType: string;
  /** Whether an H.264 encoder is actually available in this environment. */
  canEncode: boolean;
  /** Whether `moov` already precedes `mdat` (nothing to gain from a remux). */
  isFastStart: boolean;
  /** Whether the source carries metadata tags worth stripping (GPS, dates). */
  hasMetadataTags: boolean;
}

/**
 * Round to the nearest multiple of 16. Many hardware encoders — including the
 * MediaCodec ones that back WebCodecs on Android — fail or emit unplayable
 * output for dimensions that aren't a multiple of 16. The result may exceed
 * the nominal cap by up to 8px, which is immaterial.
 */
export function roundTo16(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16);
}

/**
 * Scale `width`x`height` down to fit within {@link MAX_SHORT_EDGE} /
 * {@link MAX_LONG_EDGE} while preserving aspect ratio, then round both axes to
 * a multiple of 16. Never upscales.
 */
export function scaleToFit(width: number, height: number): { width: number; height: number } {
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);

  const scale = Math.min(
    MAX_SHORT_EDGE / shortEdge,
    MAX_LONG_EDGE / longEdge,
    1,
  );

  return {
    width: roundTo16(width * scale),
    height: roundTo16(height * scale),
  };
}

/**
 * Target video bitrate for an output of the given size, scaled by pixel count
 * against the {@link VIDEO_BITRATE} reference so a 480p clip doesn't get a
 * 720p budget.
 */
export function targetVideoBitrate(width: number, height: number): number {
  const ratio = (width * height) / (MAX_LONG_EDGE * MAX_SHORT_EDGE);
  return Math.round(
    Math.min(VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, VIDEO_BITRATE * ratio)),
  );
}

/** Average total bitrate of a file, in bits per second. `null` if unknowable. */
export function averageBitrate(size: number, duration: number): number | null {
  if (!(duration > 0) || !(size > 0)) return null;
  return (size * 8) / duration;
}

/**
 * Decide how to handle a source video.
 *
 * The ladder, in order: refuse oversized input, refuse when no encoder exists,
 * take the cheap remux when the source is already close enough to our target,
 * otherwise transcode.
 */
export function decideVideoAction(probe: VideoProbe): VideoAction {
  if (!(probe.width > 0) || !(probe.height > 0)) {
    return { kind: "passthrough", reason: "unreadable" };
  }

  if (probe.size > MAX_INPUT_BYTES) {
    return { kind: "passthrough", reason: "too-large" };
  }

  const { width, height } = scaleToFit(probe.width, probe.height);
  const videoBitrate = targetVideoBitrate(width, height);

  if (isAlreadyCompliant(probe, videoBitrate)) {
    // Nothing to re-encode. A remux is still worth it if it buys us metadata
    // stripping or fast start; if it buys neither, don't touch the file.
    if (!probe.hasMetadataTags && probe.isFastStart) {
      return { kind: "passthrough", reason: "already-optimal" };
    }
    if (probe.size > MAX_REMUX_BYTES) {
      return { kind: "passthrough", reason: "too-large" };
    }
    return { kind: "remux" };
  }

  if (!probe.canEncode) {
    return { kind: "passthrough", reason: "no-encoder" };
  }

  return { kind: "transcode", width, height, videoBitrate, audioBitrate: AUDIO_BITRATE };
}

/**
 * Whether a source is close enough to our target that re-encoding would cost
 * more in quality and CPU than it saves in bytes: already H.264 in an ISOBMFF
 * container, within the resolution cap, and within {@link BITRATE_TOLERANCE}
 * of the target total bitrate.
 */
function isAlreadyCompliant(probe: VideoProbe, videoBitrate: number): boolean {
  if (probe.codec !== "avc") return false;
  if (!REMUXABLE_MIME.test(probe.mimeType)) return false;

  const shortEdge = Math.min(probe.width, probe.height);
  const longEdge = Math.max(probe.width, probe.height);
  if (shortEdge > MAX_SHORT_EDGE || longEdge > MAX_LONG_EDGE) return false;

  const actual = averageBitrate(probe.size, probe.duration);
  // Without a duration we can't judge the bitrate, so assume the worst.
  if (actual === null) return false;

  return actual <= (videoBitrate + AUDIO_BITRATE) * BITRATE_TOLERANCE;
}

/** Reads `length` bytes at `offset`. Returns fewer bytes at end of file. */
export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * Whether an ISOBMFF file already has its `moov` box before its `mdat` — i.e.
 * is already "fast start" and streamable without range requests.
 *
 * Walks only the top-level box headers (8 or 16 bytes each), seeking past each
 * box's payload, so this reads a handful of bytes regardless of file size.
 * Returns `false` for anything it can't parse, which is the safe answer: the
 * caller then remuxes, producing a file we know is fast-start.
 */
export async function isFastStartMp4(read: ByteReader, size: number): Promise<boolean> {
  let offset = 0;

  // Bounded so a malformed file can't spin forever on zero-length boxes.
  for (let i = 0; i < 64 && offset < size; i++) {
    const header = await read(offset, 16);
    if (header.length < 8) return false;

    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const type = String.fromCharCode(header[4], header[5], header[6], header[7]);

    if (type === "moov") return true;
    if (type === "mdat") return false;

    let boxSize = view.getUint32(0);
    if (boxSize === 1) {
      // 64-bit extended size follows the type. We only care about the low half;
      // a single box over 4 GiB is past anything we'd process anyway.
      if (header.length < 16) return false;
      const high = view.getUint32(8);
      if (high !== 0) return false;
      boxSize = view.getUint32(12);
    } else if (boxSize === 0) {
      // Extends to end of file, so nothing follows it.
      return false;
    }

    if (boxSize < 8) return false;
    offset += boxSize;
  }

  return false;
}

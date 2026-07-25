/// <reference lib="webworker" />

/**
 * Video processing worker.
 *
 * Probes an attached video, decides what to do with it via the pure logic in
 * `./policy.ts`, and executes that decision with mediabunny (WebCodecs). Runs
 * off the main thread because a transcode is seconds-to-minutes of solid CPU.
 *
 * Also extracts the NIP-94 metadata we attach to the message `imeta`:
 * dimensions, duration, a blurhash placeholder, and a JPEG poster frame.
 */

import { encode as blurhashEncode } from "blurhash";
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Input,
  Mp4OutputFormat,
  Output,
  type AudioCodec,
  type InputVideoTrack,
  type MetadataTags,
} from "mediabunny";

import {
  AUDIO_BITRATE,
  decideVideoAction,
  isFastStartMp4,
  KEYFRAME_INTERVAL,
  type VideoAction,
  type VideoProbe,
} from "./policy";

import type { ProcessedVideo, WorkerRequest, WorkerResponse } from "./types";

/** Width of the poster frame we generate, in pixels. */
const POSTER_WIDTH = 320;

/** JPEG quality for the poster frame. */
const POSTER_QUALITY = 0.75;

/** Width used to sample pixels for the blurhash (matches the image path). */
const BLURHASH_SAMPLE_WIDTH = 64;

/**
 * Audio codecs that can ride along in an MP4 untouched. Copying beats
 * re-encoding on quality, speed, and encoder availability, and phone video is
 * essentially always AAC already.
 */
const MP4_AUDIO_CODECS = new Set<AudioCodec>(["aac", "opus", "mp3", "flac", "ac3", "eac3"]);

/** The in-flight conversion, so a cancel message can abort it. */
let active: Conversion | null = null;

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "cancel") {
    await active?.cancel().catch(() => {});
    return;
  }

  try {
    const result = await process(message.file);
    // The output file and poster are Blobs; structured clone handles them
    // without a copy of the underlying bytes.
    post({ type: "done", result });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    active = null;
  }
};

function post(response: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
}

async function process(file: File): Promise<ProcessedVideo> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    // Audio-only or unparseable: nothing for us to do.
    return { file, action: "passthrough" };
  }

  const probe = await buildProbe(file, input, videoTrack);
  const action = decideVideoAction(probe);

  // Poster and blurhash come from the source, not the output: visually
  // equivalent, and it means we still get them on the passthrough paths.
  const preview = await extractPreview(videoTrack);

  const base = {
    duration: probe.duration > 0 ? Math.round(probe.duration) : undefined,
    blurhash: preview?.blurhash,
    poster: preview?.poster,
  };

  if (action.kind === "passthrough") {
    return { ...base, file, dim: dimOf(probe.width, probe.height), action: "passthrough" };
  }

  const converted = await convert(file, input, action);
  if (!converted) {
    // Conversion turned out to be impossible (e.g. no encodable audio codec);
    // sending the original beats failing the message.
    return { ...base, file, dim: dimOf(probe.width, probe.height), action: "passthrough" };
  }

  return {
    ...base,
    file: converted,
    dim: action.kind === "transcode"
      ? dimOf(action.width, action.height)
      : dimOf(probe.width, probe.height),
    action: action.kind,
  };
}

async function buildProbe(
  file: File,
  input: Input,
  videoTrack: InputVideoTrack,
): Promise<VideoProbe> {
  const [width, height, duration, tags] = await Promise.all([
    videoTrack.getDisplayWidth(),
    videoTrack.getDisplayHeight(),
    input.computeDuration().catch(() => 0),
    input.getMetadataTags().catch(() => ({}) as MetadataTags),
  ]);

  const canEncode = (await getFirstEncodableVideoCodec(["avc"], { width, height })) !== null;

  const isFastStart = await isFastStartMp4(
    async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
    file.size,
  ).catch(() => false);

  return {
    size: file.size,
    duration,
    width,
    height,
    codec: videoTrack.codec,
    mimeType: file.type,
    canEncode,
    isFastStart,
    hasMetadataTags: hasMeaningfulTags(tags),
  };
}

/**
 * Whether a file carries metadata worth stripping. Any populated tag counts —
 * `date` and the raw dictionary are where creation timestamps and GPS
 * coordinates live.
 */
function hasMeaningfulTags(tags: MetadataTags): boolean {
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null) continue;
    if (key === "raw") {
      if (typeof value === "object" && Object.keys(value).length > 0) return true;
      continue;
    }
    if (Array.isArray(value) && value.length === 0) continue;
    return true;
  }
  return false;
}

/**
 * Grab a representative frame and derive a JPEG poster and a blurhash from it.
 *
 * Samples at 1 second rather than the first frame: videos very often open on
 * black, which makes for a useless preview.
 */
async function extractPreview(
  videoTrack: InputVideoTrack,
): Promise<{ poster: Blob; blurhash?: string } | undefined> {
  try {
    if (!(await videoTrack.canDecode())) return undefined;

    const first = await videoTrack.getFirstTimestamp();
    const duration = await videoTrack.computeDuration();
    // Prefer 1s in; for clips shorter than that, take the midpoint.
    const timestamp = duration > 2 ? first + 1 : first + Math.max(0, duration - first) / 2;

    const sink = new CanvasSink(videoTrack, { width: POSTER_WIDTH });
    const wrapped = (await sink.getCanvas(timestamp)) ?? (await sink.getCanvas(first));
    if (!wrapped) return undefined;

    const poster = await toJpeg(wrapped.canvas);
    return { poster, blurhash: computeBlurhash(wrapped.canvas) };
  } catch {
    // A missing preview costs us a placeholder, not the upload.
    return undefined;
  }
}

async function toJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: "image/jpeg", quality: POSTER_QUALITY });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode poster"))),
      "image/jpeg",
      POSTER_QUALITY,
    );
  });
}

/** Downscale to a small canvas and encode a 4x3-component blurhash. */
function computeBlurhash(source: HTMLCanvasElement | OffscreenCanvas): string | undefined {
  try {
    const scale = BLURHASH_SAMPLE_WIDTH / source.width;
    const height = Math.max(1, Math.round(source.height * scale));

    const canvas = new OffscreenCanvas(BLURHASH_SAMPLE_WIDTH, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    ctx.drawImage(source, 0, 0, BLURHASH_SAMPLE_WIDTH, height);
    const { data } = ctx.getImageData(0, 0, BLURHASH_SAMPLE_WIDTH, height);

    return blurhashEncode(data, BLURHASH_SAMPLE_WIDTH, height, 4, 3);
  } catch {
    return undefined;
  }
}

/**
 * Run the remux or transcode. Returns `null` when the conversion can't be
 * performed, leaving the caller to upload the original.
 */
async function convert(
  file: File,
  input: Input,
  action: Extract<VideoAction, { kind: "remux" | "transcode" }>,
): Promise<File | null> {
  const output = new Output({
    // Fast start puts `moov` before `mdat` so players can start without
    // fetching the whole file — the difference between a video that plays on
    // tap and one that must download in full first.
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });

  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    // Drop every metadata tag: creation date and GPS coordinates ride here.
    tags: {},
    ...(action.kind === "transcode"
      ? {
        video: {
          width: action.width,
          height: action.height,
          // Dimensions were derived from the true aspect ratio and then
          // rounded to a multiple of 16, so the residual distortion is under
          // a percent — stretching to fill beats letterboxing it.
          fit: "fill" as const,
          codec: "avc" as const,
          bitrate: action.videoBitrate,
          keyFrameInterval: KEYFRAME_INTERVAL,
        },
        audio: audioOptions,
      }
      : {}),
  });

  if (!conversion.isValid) return null;

  // Silently dropping someone's audio is worse than sending a bigger file.
  if (conversion.discardedTracks.some((t) => t.track.type === "audio")) return null;

  active = conversion;
  conversion.onProgress = (progress) => post({ type: "progress", value: progress });

  await conversion.execute();

  const buffer = output.target.buffer;
  if (!buffer) return null;

  return new File([buffer], replaceExtension(file.name, ".mp4"), { type: "video/mp4" });
}

/**
 * Keep the audio track as-is whenever MP4 can hold it, so we depend on an
 * audio encoder only for genuinely foreign codecs (e.g. Vorbis out of a WebM).
 */
async function audioOptions(track: { codec: AudioCodec | null }) {
  if (track.codec && MP4_AUDIO_CODECS.has(track.codec)) return {};

  const codec = await getFirstEncodableAudioCodec(["aac", "opus"]);
  if (!codec) return {};

  return { codec, bitrate: AUDIO_BITRATE };
}

function dimOf(width: number, height: number): string | undefined {
  return width > 0 && height > 0 ? `${width}x${height}` : undefined;
}

function replaceExtension(filename: string, ext: string): string {
  const dot = filename.lastIndexOf(".");
  return (dot > 0 ? filename.slice(0, dot) : filename) + ext;
}

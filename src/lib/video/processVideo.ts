import { encode as blurhashEncode } from "blurhash";

import type { ProcessedVideo, WorkerRequest, WorkerResponse } from "./types";

export type { ProcessedVideo } from "./types";

/** Width of the poster frame produced by the fallback path. */
const POSTER_WIDTH = 320;

/** JPEG quality for the fallback poster frame. */
const POSTER_QUALITY = 0.75;

/** Width used to sample pixels for the blurhash. */
const BLURHASH_SAMPLE_WIDTH = 64;

/** How long to wait on the fallback `<video>` element before giving up. */
const FALLBACK_TIMEOUT_MS = 15_000;

export interface ProcessVideoOptions {
  /** Called with a 0..1 fraction as the transcode advances. */
  onProgress?: (progress: number) => void;
  /** Aborts processing; the original file is uploaded instead. */
  signal?: AbortSignal;
}

/** Whether WebCodecs video compression is available (minSdk 24 WebViews may lack it). */
export function canProcessVideo(): boolean {
  return typeof Worker !== "undefined"
    && typeof OffscreenCanvas !== "undefined"
    && typeof globalThis.VideoEncoder !== "undefined"
    && typeof globalThis.VideoDecoder !== "undefined";
}

/**
 * Compress an attached video and extract NIP-94 metadata. Never throws for
 * media reasons: failures degrade to uploading the original.
 */
export async function processVideo(
  file: File,
  options: ProcessVideoOptions = {},
): Promise<ProcessedVideo> {
  if (!canProcessVideo()) {
    // A plain <video> still yields dim, duration, poster and blurhash.
    return extractWithVideoElement(file);
  }

  try {
    return await runWorker(file, options);
  } catch {
    return extractWithVideoElement(file);
  }
}

function runWorker(file: File, options: ProcessVideoOptions): Promise<ProcessedVideo> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

    const finish = (fn: () => void) => {
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      fn();
    };

    function onAbort() {
      worker.postMessage({ type: "cancel" } satisfies WorkerRequest);
      finish(() => resolve({ file, action: "passthrough" }));
    }

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        options.onProgress?.(message.value);
      } else if (message.type === "done") {
        finish(() => resolve(message.result));
      } else {
        finish(() => reject(new Error(message.message)));
      }
    };

    worker.onerror = (event) => finish(() => reject(new Error(event.message || "Video worker failed")));

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    worker.postMessage({ type: "process", file } satisfies WorkerRequest);
  });
}

/** Metadata-only fallback without WebCodecs, via an ordinary `<video>` element. */
async function extractWithVideoElement(file: File): Promise<ProcessedVideo> {
  const passthrough: ProcessedVideo = { file, action: "passthrough" };
  if (typeof document === "undefined") return passthrough;

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");

  try {
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    await withTimeout(once(video, "loadedmetadata"), FALLBACK_TIMEOUT_MS);

    const width = video.videoWidth;
    const height = video.videoHeight;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;

    const result: ProcessedVideo = {
      ...passthrough,
      dim: width > 0 && height > 0 ? `${width}x${height}` : undefined,
      duration: duration > 0 ? Math.round(duration) : undefined,
    };

    // Seek off the first frame, which is so often black.
    const seekTo = duration > 2 ? 1 : duration / 2;
    const seeked = once(video, "seeked");
    video.currentTime = seekTo;
    await withTimeout(seeked, FALLBACK_TIMEOUT_MS);

    const frame = drawFrame(video, width, height);
    if (!frame) return result;

    return {
      ...result,
      poster: await canvasToJpeg(frame),
      blurhash: blurhashOf(frame),
    };
  } catch {
    return passthrough;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Draw the current video frame into a poster-sized canvas. */
function drawFrame(video: HTMLVideoElement, width: number, height: number): HTMLCanvasElement | null {
  if (!(width > 0) || !(height > 0)) return null;

  const scale = Math.min(1, POSTER_WIDTH / width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function blurhashOf(source: HTMLCanvasElement): string | undefined {
  try {
    const scale = BLURHASH_SAMPLE_WIDTH / source.width;
    const height = Math.max(1, Math.round(source.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = BLURHASH_SAMPLE_WIDTH;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    ctx.drawImage(source, 0, 0, BLURHASH_SAMPLE_WIDTH, height);
    const { data } = ctx.getImageData(0, 0, BLURHASH_SAMPLE_WIDTH, height);

    return blurhashEncode(data, BLURHASH_SAMPLE_WIDTH, height, 4, 3);
  } catch {
    return undefined;
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode poster"))),
      "image/jpeg",
      POSTER_QUALITY,
    );
  });
}

function once(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true });
    target.addEventListener("error", () => reject(new Error(`Video ${event} failed`)), { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Timed out")), ms)),
  ]);
}

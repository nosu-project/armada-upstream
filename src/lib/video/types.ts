/**
 * Message contract between the composer and the video processing worker.
 * Kept in its own module so the main thread can import these types without
 * pulling mediabunny into the main bundle.
 */

/** The outcome of processing an attached video. */
export interface ProcessedVideo {
  /** The file to upload. The original when nothing needed doing. */
  file: File;
  /** Output pixel dimensions as `"WxH"`, for the NIP-94 `dim` field. */
  dim?: string;
  /** Duration in whole seconds, for the NIP-94 `duration` field. */
  duration?: number;
  /** Blurhash of the poster frame, for the NIP-94 `blurhash` field. */
  blurhash?: string;
  /** JPEG poster frame, uploaded separately and referenced as `image`. */
  poster?: Blob;
  /** What actually happened, for logging. */
  action: "passthrough" | "remux" | "transcode";
}

export type WorkerRequest =
  | { type: "process"; file: File }
  | { type: "cancel" };

export type WorkerResponse =
  | { type: "progress"; value: number }
  | { type: "done"; result: ProcessedVideo }
  | { type: "error"; message: string };

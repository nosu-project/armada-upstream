/** Main thread ↔ media worker message contract; separate so the main bundle skips mediabunny. */

import type { AudioMetadata } from "@/lib/audioMetadata";

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
  | { type: "cancel" }
  | { type: "audioTags"; id: number; source: Blob | string };

export type WorkerResponse =
  | { type: "progress"; value: number }
  | { type: "done"; result: ProcessedVideo }
  | { type: "error"; message: string }
  | { type: "audioTags"; id: number; result: AudioMetadata };

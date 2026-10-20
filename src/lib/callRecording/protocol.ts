import type { RecordingFormat } from "@/lib/callRecording/formats";

/** OPFS directory the worker stages takes in; `purgeClientStorage` removes it on logout. */
export const STAGING_DIR = "armada-call-recordings";

export type ToWorker =
  | { type: "init"; id: string; format: RecordingFormat; sampleRate: number }
  | { type: "start"; startFrame: number }
  /** A voice gets its own file; `port` carries the tap's frames. */
  | { type: "track"; key: string; title: string; port: MessagePort }
  | { type: "stop"; endFrame: number }
  | { type: "abort" };

export type FromWorker =
  | { type: "ready" }
  | { type: "stopped"; files: StagedFile[] }
  | { type: "error"; message: string; quota: boolean };

/** Frames from the audio thread: `f` is the context frame of `d[0]`. */
export type TapChunk = { f: number; d: Float32Array } | { done: true };

/** What the tap's node port accepts. */
export type TapControl = { port: MessagePort } | { flush: true };

export interface StagedFile {
  key: string;
  title: string;
  /** The file's name inside `STAGING_DIR/<id>/`. */
  staged: string;
  bytes: number;
}

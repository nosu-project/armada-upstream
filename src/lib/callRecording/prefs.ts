import type { RecordingMode } from "@/lib/callRecording/engine";
import { RECORDING_FORMATS, type RecordingFormat } from "@/lib/callRecording/formats";
import { DEFAULT_TEMPLATE } from "@/lib/callRecording/template";

const OPTIONS_KEY = "armada:voice:recording";
const NO_RECORD_KEY = "armada:voice:noRecord";

export interface RecorderOptions {
  mode: RecordingMode;
  format: RecordingFormat;
  template: string;
}

export const DEFAULT_RECORDER_OPTIONS: RecorderOptions = {
  // One file per voice: what a podcast edit needs.
  mode: "multichannel",
  format: "flac",
  template: DEFAULT_TEMPLATE,
};

export function getRecorderOptions(): RecorderOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null") as Partial<RecorderOptions> | null;
    return {
      mode: raw?.mode === "mixdown" ? "mixdown" : "multichannel",
      format: RECORDING_FORMATS.includes(raw?.format as RecordingFormat)
        ? (raw!.format as RecordingFormat)
        : DEFAULT_RECORDER_OPTIONS.format,
      template: typeof raw?.template === "string" ? raw.template : DEFAULT_TEMPLATE,
    };
  } catch {
    return DEFAULT_RECORDER_OPTIONS;
  }
}

export function setRecorderOptions(options: RecorderOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // storage unavailable
  }
}

const listeners = new Set<() => void>();

/** Whether this device refuses to be recorded in calls. */
export function getNoRecord(): boolean {
  try {
    return localStorage.getItem(NO_RECORD_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNoRecord(noRecord: boolean): void {
  try {
    if (noRecord) localStorage.setItem(NO_RECORD_KEY, "1");
    else localStorage.removeItem(NO_RECORD_KEY);
  } catch {
    // storage unavailable
  }
  for (const listener of listeners) listener();
}

export function subscribeNoRecord(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

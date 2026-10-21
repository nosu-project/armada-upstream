/**
 * The formats a call can be recorded in — Mumble's list, less Vorbis and MP3,
 * which no browser can encode. Opus goes through WebCodecs, so it is offered
 * only where `AudioEncoder` accepts it.
 */
export type RecordingFormat = "wav" | "flac" | "opus" | "au";

export const RECORDING_FORMATS: readonly RecordingFormat[] = ["flac", "wav", "opus", "au"];

export const FORMAT_EXTENSION: Record<RecordingFormat, string> = {
  wav: "wav",
  flac: "flac",
  opus: "opus",
  au: "au",
};

export const FORMAT_MIME: Record<RecordingFormat, string> = {
  wav: "audio/wav",
  flac: "audio/flac",
  opus: "audio/ogg",
  au: "audio/basic",
};

export const OPUS_BITRATE = 96_000;

let opusSupport: Promise<boolean> | null = null;

/** Whether this browser can encode Opus mono at `sampleRate` (WebCodecs). */
export function canRecordOpus(sampleRate = 48_000): Promise<boolean> {
  if (sampleRate !== 48_000) return Promise.resolve(false);
  opusSupport ??= (async () => {
    if (typeof AudioEncoder === "undefined") return false;
    try {
      const { supported } = await AudioEncoder.isConfigSupported({
        codec: "opus",
        sampleRate,
        numberOfChannels: 1,
        bitrate: OPUS_BITRATE,
      });
      return Boolean(supported);
    } catch {
      return false;
    }
  })();
  return opusSupport;
}

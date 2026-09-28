/**
 * An audio file's waveform, computed from its own decoded samples — the
 * shape a voice message's recorder sends as its imeta `waveform`, derived
 * instead for a file that came with none.
 */

/** Amplitude points per file, matching what the voice recorder sends. */
export const WAVEFORM_SAMPLES = 100;

/**
 * Largest file decoded for a waveform. Decoding holds the file and its PCM in
 * memory at once; past this the picture isn't worth the phone's memory.
 */
export const MAX_WAVEFORM_BYTES = 64 * 1024 * 1024;

/**
 * Rate the audio is decoded at. The shape at 100 points is the same at 8 kHz
 * as at 48, and a five-minute stereo track is 19 MB of samples here rather
 * than 110.
 */
const DECODE_SAMPLE_RATE = 8000;

/**
 * RMS loudness per bucket across all channels, scaled so the loudest bucket
 * is 100 — a mastered track and a quiet field recording both fill the bar
 * height, and the shape is what differs.
 */
export function waveformFromChannels(channels: Float32Array[], samples = WAVEFORM_SAMPLES): number[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0 || samples <= 0) return [];
  const count = Math.min(samples, length);
  const rms: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * length) / count);
    const end = Math.floor(((i + 1) * length) / count);
    let sum = 0;
    for (const channel of channels) {
      for (let j = start; j < end; j++) sum += channel[j] * channel[j];
    }
    rms.push(Math.sqrt(sum / ((end - start) * channels.length)));
  }
  const loudest = Math.max(...rms);
  if (!(loudest > 0)) return rms.map(() => 0);
  return rms.map((v) => Math.round((v / loudest) * 100));
}

/**
 * Decode an audio file and reduce it to {@link WAVEFORM_SAMPLES} points.
 * Undefined when the file is too big, this environment has no Web Audio, or
 * the browser can't decode the format — the caller shows a placeholder.
 */
export async function computeWaveform(file: Blob): Promise<number[] | undefined> {
  if (file.size === 0 || file.size > MAX_WAVEFORM_BYTES) return undefined;
  if (typeof OfflineAudioContext === "undefined") return undefined;
  try {
    const bytes = await file.arrayBuffer();
    const buffer = await decode(bytes);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const waveform = waveformFromChannels(channels);
    return waveform.length > 0 ? waveform : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `decodeAudioData` resamples to its context's rate. Some WebKit builds refuse
 * a context below 22.05 kHz, so a refused low rate falls back to the full one.
 */
async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  let ctx: OfflineAudioContext;
  try {
    ctx = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);
  } catch {
    ctx = new OfflineAudioContext(1, 1, 44100);
  }
  return ctx.decodeAudioData(bytes);
}

/**
 * Fetch a file for its waveform. A `blob:` URL is an attachment already in
 * memory (decrypted, or picked locally); an http(s) one is downloaded, and
 * refused before its body is read when it declares itself too big.
 */
export async function computeWaveformFromUrl(url: string): Promise<number[] | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_WAVEFORM_BYTES) {
      void res.body?.cancel();
      return undefined;
    }
    return await computeWaveform(await res.blob());
  } catch {
    return undefined;
  }
}

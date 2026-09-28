/** An audio file's waveform computed from its decoded samples, for files sent without an imeta `waveform`. */

/** Amplitude points per file, matching what the voice recorder sends. */
export const WAVEFORM_SAMPLES = 100;

/** Largest file decoded for a waveform (file + PCM are held in memory at once). */
export const MAX_WAVEFORM_BYTES = 64 * 1024 * 1024;

/** Decode rate; 100 points look the same at 8 kHz and it cuts sample memory ~6×. */
const DECODE_SAMPLE_RATE = 8000;

/** RMS loudness per bucket across channels, normalized so the loudest bucket is 100. */
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

/** Decode a file to {@link WAVEFORM_SAMPLES} points; undefined if too big or undecodable. */
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

/** Some WebKit builds refuse a context below 22.05 kHz, so fall back to 44.1 kHz. */
async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  let ctx: OfflineAudioContext;
  try {
    ctx = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);
  } catch {
    ctx = new OfflineAudioContext(1, 1, 44100);
  }
  return ctx.decodeAudioData(bytes);
}

/** Fetch a file for its waveform, refusing a declared-too-big body before reading it. */
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

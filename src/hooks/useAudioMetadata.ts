import { createAttachmentCache } from "@/hooks/attachmentCache";
import { readAudioMetadata, type AudioMetadata } from "@/lib/audioMetadata";
import { computeWaveformFromUrl } from "@/lib/audioWaveform";

/** An attachment's tags, with its cover as an object URL ready for an `<img>`. */
export type AudioDisplay = Omit<AudioMetadata, "cover"> & { coverUrl?: string };

/** Whether there is anything to show beyond a bare player. */
export function hasAudioMetadata(meta: AudioDisplay | undefined): meta is AudioDisplay {
  return !!meta && !!(meta.title || meta.artist || meta.album || meta.coverUrl);
}

function toDisplay({ cover, ...tags }: AudioMetadata): AudioDisplay {
  return { ...tags, coverUrl: cover ? URL.createObjectURL(cover) : undefined };
}

/** The tags and cover art embedded in audio attachments. */
const metadataCache = createAttachmentCache<AudioDisplay>({
  max: 200,
  read: async (src) => toDisplay(await readAudioMetadata(src)),
  dispose: (display) => {
    if (display.coverUrl) URL.revokeObjectURL(display.coverUrl);
  },
});

/**
 * Waveforms computed from audio attachments' decoded samples. `null` records
 * a file that has none to give (undecodable, too big), so it isn't retried.
 */
const waveformCache = createAttachmentCache<number[] | null>({
  max: 500,
  read: async (src) => (await computeWaveformFromUrl(src)) ?? null,
});

/**
 * Seed the metadata cache with what was read from the local file, so the
 * composer's card and the sent message show it without fetching the upload
 * back.
 */
export function primeAudioMetadata(key: string, meta: AudioMetadata): void {
  metadataCache.prime(key, toDisplay(meta));
}

/** Seed the waveform cache from the local file, likewise. */
export function primeAudioWaveform(key: string, waveform: number[] | undefined): void {
  waveformCache.prime(key, waveform ?? null);
}

/** Drop every cached track's tags, cover and waveform. */
export function clearAudioMetadata(): void {
  metadataCache.clear();
  waveformCache.clear();
}

/**
 * The tags and cover art embedded in an audio attachment. `key` names the
 * attachment; `src` is where its bytes can be read (the resolved — decrypted
 * or media-policy-routed — source), and without one only an already-read
 * result is returned. An http(s) `src` is read by range request, so only the
 * tag block is fetched.
 */
export function useAudioMetadata(key: string, src?: string): AudioDisplay | undefined {
  return metadataCache.useValue(key, src);
}

/**
 * The waveform of an audio attachment, from its decoded samples. Unlike the
 * tags this needs the WHOLE file, so the caller decides when `src` is worth
 * handing over; `null` means the file has none to give.
 */
export function useAudioWaveform(key: string, src?: string): number[] | null | undefined {
  return waveformCache.useValue(key, src);
}

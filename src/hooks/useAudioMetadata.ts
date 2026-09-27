import { useEffect, useState } from "react";

import { readAudioMetadata, type AudioMetadata } from "@/lib/audioMetadata";

/** An attachment's tags, with its cover as an object URL ready for an `<img>`. */
export type AudioDisplay = Omit<AudioMetadata, "cover"> & { coverUrl?: string };

/** Whether there is anything to show beyond a bare player. */
export function hasAudioMetadata(meta: AudioDisplay | undefined): meta is AudioDisplay {
  return !!meta && !!(meta.title || meta.artist || meta.album || meta.coverUrl);
}

/** How many tracks' metadata the session keeps; the oldest goes first. */
const MAX_ENTRIES = 200;

/**
 * Read once per attachment per session, keyed by the attachment's URL rather
 * than the per-decrypt object URL it resolved to. A decrypted track's title
 * and cover are plaintext, so {@link clearAudioMetadata} runs with the purge.
 */
const settled = new Map<string, AudioDisplay>();
const pending = new Map<string, Promise<AudioDisplay>>();

function settle(key: string, meta: AudioMetadata): AudioDisplay {
  const { cover, ...tags } = meta;
  const display: AudioDisplay = { ...tags, coverUrl: cover ? URL.createObjectURL(cover) : undefined };
  const previous = settled.get(key);
  if (previous?.coverUrl) URL.revokeObjectURL(previous.coverUrl);
  settled.delete(key);
  settled.set(key, display);
  while (settled.size > MAX_ENTRIES) {
    const [oldest, entry] = settled.entries().next().value!;
    if (entry.coverUrl) URL.revokeObjectURL(entry.coverUrl);
    settled.delete(oldest);
  }
  return display;
}

/**
 * Seed the cache with metadata already read from the local file, so the
 * composer's card and the sent message show it without fetching the upload
 * back.
 */
export function primeAudioMetadata(key: string, meta: AudioMetadata): void {
  settle(key, meta);
}

/** Drop every cached track (and its cover's object URL). */
export function clearAudioMetadata(): void {
  for (const entry of settled.values()) {
    if (entry.coverUrl) URL.revokeObjectURL(entry.coverUrl);
  }
  settled.clear();
  pending.clear();
}

function load(key: string, src: string): Promise<AudioDisplay> {
  let promise = pending.get(key);
  if (!promise) {
    promise = readAudioMetadata(src).then((meta) => {
      // A purge while the read was in flight dropped this entry; don't refill.
      if (pending.get(key) !== promise) return {};
      pending.delete(key);
      return settle(key, meta);
    });
    pending.set(key, promise);
  }
  return promise;
}

/**
 * The tags and cover art embedded in an audio attachment. `key` names the
 * attachment; `src` is where its bytes can be read (the resolved — decrypted
 * or media-policy-routed — source), and without one only an already-read
 * result is returned.
 */
export function useAudioMetadata(key: string, src?: string): AudioDisplay | undefined {
  const [meta, setMeta] = useState<AudioDisplay | undefined>(() => settled.get(key));

  useEffect(() => {
    const done = settled.get(key);
    if (done) {
      setMeta(done);
      return;
    }
    setMeta(undefined);
    if (!src) return;
    let live = true;
    void load(key, src).then((result) => {
      if (live) setMeta(result);
    });
    return () => {
      live = false;
    };
  }, [key, src]);

  return meta;
}

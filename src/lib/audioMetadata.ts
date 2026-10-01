/** Pure tag normalization; the reading itself runs in the media worker (`readAudioMetadata.ts`). */

import type { MetadataTags } from "mediabunny";

/** Tags read from a music file's own container metadata (ID3, Vorbis, MP4 `ilst`). */
export interface AudioMetadata {
  title?: string;
  artist?: string;
  album?: string;
  /** Release year, four digits. */
  year?: string;
  /** The embedded front cover, as the file carries it. */
  cover?: Blob;
}

/** Cap on a displayed tag: the bytes are the sender's to fill. */
const MAX_TAG_CHARS = 200;

function cleanTag(value: string | undefined): string | undefined {
  // eslint-disable-next-line no-control-regex
  const line = value?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line ? line.slice(0, MAX_TAG_CHARS) : undefined;
}

/** Normalize tags for display; the album artist only stands in for a missing track artist. */
export function audioTagsFrom(tags: MetadataTags): Omit<AudioMetadata, "cover"> {
  const year = tags.date && !Number.isNaN(tags.date.getTime()) ? String(tags.date.getUTCFullYear()) : undefined;
  return {
    title: cleanTag(tags.title),
    artist: cleanTag(tags.artist) ?? cleanTag(tags.albumArtist),
    album: cleanTag(tags.album),
    year: year && /^\d{4}$/.test(year) ? year : undefined,
  };
}

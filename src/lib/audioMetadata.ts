import type { MetadataTags } from "mediabunny";

/** The descriptive tags of a music file that ride in its imeta. */
export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
  /** Release year, four digits. */
  year?: string;
}

/** What an attached audio file says about itself. */
export interface AudioMetadata extends AudioTags {
  /** Seconds, rounded; absent when the container doesn't say. */
  duration?: number;
  /** The embedded front cover, re-encoded small enough to upload beside it. */
  cover?: File;
}

/** Longest side of the re-encoded cover. It is shown at thumbnail size. */
const COVER_MAX_DIMENSION = 600;

/** JPEG quality for the re-encoded cover. */
const COVER_QUALITY = 0.85;

/** Cap on a tag value: an imeta field is one line, not a liner note. */
const MAX_TAG_CHARS = 200;

/** The imeta field names these tags are written under, in order. */
export const AUDIO_TAG_FIELDS = ["title", "artist", "album", "year"] as const satisfies readonly (keyof AudioTags)[];

/** One line, trimmed and capped — a tag value is sender-controlled text. */
function cleanTag(value: string | undefined): string | undefined {
  // eslint-disable-next-line no-control-regex
  const line = value?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line ? line.slice(0, MAX_TAG_CHARS) : undefined;
}

/**
 * Normalize a container's metadata into the fields Armada sends. The track
 * artist wins over the album artist, which only stands in when the track has
 * none (a compilation's album artist is "Various Artists").
 */
export function audioTagsFrom(tags: MetadataTags): AudioTags {
  const year = tags.date && !Number.isNaN(tags.date.getTime()) ? String(tags.date.getUTCFullYear()) : undefined;
  return {
    title: cleanTag(tags.title),
    artist: cleanTag(tags.artist) ?? cleanTag(tags.albumArtist),
    album: cleanTag(tags.album),
    year: year && /^\d{4}$/.test(year) ? year : undefined,
  };
}

/**
 * Read an attached audio file's tags, duration and front cover (ID3, Vorbis
 * comments, MP4 `ilst`, …). Never throws: a file mediabunny can't parse just
 * comes back with nothing, and uploads as it would have anyway.
 */
export async function extractAudioMetadata(file: File): Promise<AudioMetadata> {
  let input: import("mediabunny").Input | undefined;
  try {
    // Loaded on demand: the main bundle has no other use for it.
    const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const [tags, duration] = await Promise.all([
      input.getMetadataTags().catch(() => ({}) as MetadataTags),
      readDuration(input),
    ]);

    const images = tags.images ?? [];
    const art = images.find((img) => img.kind === "coverFront") ?? images[0];
    const cover = art ? await encodeCover(art.data, art.mimeType, file.name).catch(() => undefined) : undefined;

    return {
      ...audioTagsFrom(tags),
      duration: duration && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined,
      cover,
    };
  } catch {
    return {};
  } finally {
    input?.dispose();
  }
}

async function readDuration(input: import("mediabunny").Input): Promise<number | undefined> {
  try {
    return (await input.getDurationFromMetadata()) ?? (await input.computeDuration());
  } catch {
    return undefined;
  }
}

/**
 * Scale the embedded picture down and re-encode it as a JPEG. Re-encoding is
 * also what strips any EXIF the tagger left in it, and an embedded cover can
 * be a 3000px PNG — far too much to fetch for a thumbnail.
 */
async function encodeCover(data: Uint8Array, mimeType: string, audioName: string): Promise<File> {
  const bitmap = await createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type: mimeType || "image/jpeg" }));
  const scale = Math.min(1, COVER_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Canvas 2D context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Cover encode failed"))), "image/jpeg", COVER_QUALITY));
  const base = audioName.replace(/\.[^./]*$/, "") || "cover";
  return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
}

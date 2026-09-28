import { Capacitor, registerPlugin } from "@capacitor/core";

// The device's recent photos/videos for the attach sheet (MediaGalleryPlugin.java). Android only.

/** `limited` is Android 14+'s "Select photos": only the user's picks are listed. */
export type MediaAccess = "full" | "limited" | "denied" | "prompt";

export interface GalleryItem {
  id: number;
  uri: string;
  video: boolean;
  mime: string | null;
  name: string | null;
  size: number;
  /** Seconds since the epoch; part of the thumbnail cache key. */
  modified: number;
  width: number;
  height: number;
  /** Milliseconds, videos only. */
  duration: number;
}

interface MediaGalleryPlugin {
  checkAccess(): Promise<{ access: MediaAccess }>;
  requestAccess(): Promise<{ access: MediaAccess }>;
  openSettings(): Promise<void>;
  list(opts: { limit: number; offset: number }): Promise<{ items: GalleryItem[]; more: boolean }>;
  thumbnail(opts: { id: number; video: boolean; modified: number }): Promise<{ path: string }>;
}

const MediaGallery = registerPlugin<MediaGalleryPlugin>("MediaGallery");

export function hasMediaGallery(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("MediaGallery");
}

export async function checkMediaAccess(): Promise<MediaAccess> {
  return (await MediaGallery.checkAccess()).access;
}

export async function requestMediaAccess(): Promise<MediaAccess> {
  return (await MediaGallery.requestAccess()).access;
}

export function openMediaSettings(): Promise<void> {
  return MediaGallery.openSettings();
}

export function listRecentMedia(offset: number, limit = 60): Promise<{ items: GalleryItem[]; more: boolean }> {
  return MediaGallery.list({ limit, offset });
}

/** Thumbnail URLs memoized per item; each miss is a bridge call plus a decode. */
const thumbs = new Map<string, Promise<string>>();

export function galleryThumbnailSrc(item: GalleryItem): Promise<string> {
  const key = `${item.video ? "v" : "i"}${item.id}-${item.modified}`;
  let src = thumbs.get(key);
  if (!src) {
    src = MediaGallery.thumbnail({ id: item.id, video: item.video, modified: item.modified })
      .then(({ path }) => Capacitor.convertFileSrc(path));
    src.catch(() => thumbs.delete(key));
    thumbs.set(key, src);
  }
  return src;
}

/** A loadable URL for the item itself, for the full-size preview. */
export function galleryItemSrc(item: GalleryItem): string {
  return Capacitor.convertFileSrc(item.uri);
}

/**
 * The item as a File, fetched from the content:// URI via Capacitor's local
 * server (not a plugin result, which would re-serialize every byte). Reads the
 * whole item, so callers must check `item.size` first.
 */
export async function galleryItemFile(item: GalleryItem): Promise<File> {
  const res = await fetch(Capacitor.convertFileSrc(item.uri));
  if (!res.ok) throw new Error(`Could not read ${item.name ?? "media"} (${res.status})`);
  const blob = await res.blob();
  const type = item.mime || blob.type;
  const name = item.name || `${item.video ? "video" : "image"}-${item.id}${extensionFor(type)}`;
  return new File([blob], name, { type, lastModified: item.modified * 1000 });
}

function extensionFor(mime: string): string {
  const sub = mime.split("/")[1]?.split(/[;+]/)[0];
  if (!sub) return "";
  return `.${sub === "jpeg" ? "jpg" : sub === "quicktime" ? "mov" : sub}`;
}

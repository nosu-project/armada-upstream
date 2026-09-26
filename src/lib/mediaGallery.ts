import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * The device's recent photos and videos, for the attach sheet's grid
 * (MediaGalleryPlugin.java). Android only: iOS and the web have no equivalent
 * here and keep the system picker, which on iOS already is the photo library.
 */

/** `limited` is Android 14+'s "Select photos": only the user's picks are listed. */
export type MediaAccess = "full" | "limited" | "denied" | "prompt";

export interface GalleryItem {
  id: number;
  /** content:// URI of the item. */
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
  /** The item is named by its MediaStore id; the plugin rebuilds its URI. */
  thumbnail(opts: { id: number; video: boolean; modified: number }): Promise<{ path: string }>;
}

const MediaGallery = registerPlugin<MediaGalleryPlugin>("MediaGallery");

/** Whether this build has the native gallery (an Android build that ships the plugin). */
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

/**
 * A loadable URL for an item's thumbnail. Memoized per item for the session,
 * since the grid re-renders tiles far more often than thumbnails change — and
 * each miss is a bridge call plus, the first time, a decode.
 */
const thumbs = new Map<string, Promise<string>>();

export function galleryThumbnailSrc(item: GalleryItem): Promise<string> {
  const key = `${item.video ? "v" : "i"}${item.id}-${item.modified}`;
  let src = thumbs.get(key);
  if (!src) {
    src = MediaGallery.thumbnail({ id: item.id, video: item.video, modified: item.modified })
      .then(({ path }) => Capacitor.convertFileSrc(path));
    // A failure is not remembered: the next render may ask again.
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
 * The item's bytes as a File for the upload pipeline, read by the WebView
 * straight from the content:// URI through Capacitor's local server — not
 * through a plugin result, which would re-serialize every byte.
 *
 * The whole item is read into a Blob, so the caller gates on `item.size`
 * (MediaStore's figure) BEFORE calling this — reading first and refusing after
 * would already have paid for a multi-hundred-megabyte video.
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

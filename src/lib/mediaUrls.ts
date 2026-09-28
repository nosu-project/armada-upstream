import { WEBXDC_MIME } from "@/lib/webxdcMime";
export const IMAGE_EXTS = 'jpg|jpeg|png|gif|webp|svg|avif';

/** Video extensions rendered as players. */
export const VIDEO_EXTS = 'mp4|webm|mov|qt|avi|mkv|flv';

/** Includes mime-db synonyms Blossom uses for content-addressed blobs (`.mpga`, `.oga`, `.weba`). */
export const AUDIO_EXTS = 'mp3|mpga|wav|ogg|oga|flac|m4a|aac|opus|weba';

/** All media extensions (image + video + audio + webxdc). */
export const ALL_MEDIA_EXTS = `${IMAGE_EXTS}|${VIDEO_EXTS}|${AUDIO_EXTS}|xdc`;

export const IMAGE_URL_REGEX = new RegExp(
  `https?:\\/\\/[^\\s]+\\.(${IMAGE_EXTS})(\\?[^\\s]*)?`,
  'i',
);
/** Matches any media URL (video, audio, webxdc) that is rendered as an embed — not a link preview. */
export const EMBED_MEDIA_URL_REGEX = new RegExp(
  `https?:\\/\\/[^\\s]+\\.(${VIDEO_EXTS}|${AUDIO_EXTS}|xdc)(\\?[^\\s]*)?`,
  'i',
);

/** Matches all NIP-92 media URLs for imeta tag generation (images + video + audio + webxdc). */
export const IMETA_MEDIA_URL_REGEX = new RegExp(
  `https?:\\/\\/[^\\s]+\\.(${ALL_MEDIA_EXTS})(\\?[^\\s]*)?`,
  'gi',
);
/**
 * Hosts whose "videos" are GIF renditions (Tenor/Giphy pickers share .mp4/.webm).
 * Dot-boundary match so lookalikes like `nottenor.com` don't qualify.
 */
const GIF_VIDEO_HOST_REGEX = /(^|\.)(tenor\.com|giphy\.com)$/i;

/** Whether a video URL should render as a GIF (autoplay, loop, muted): known GIF hosts or `.gif.mp4`/`.gif.webm`. */
export function isGifLikeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (GIF_VIDEO_HOST_REGEX.test(parsed.hostname)) return true;
  return /\.gif\.(mp4|webm)$/i.test(parsed.pathname);
}

/**
 * Containers in {@link VIDEO_EXTS} no browser plays; rendered as downloads.
 * mkv is omitted: Chromium plays it when the codecs are supported.
 */
const UNPLAYABLE_VIDEO_EXTS = /^(avi|flv|wmv|asf|mpg|mpeg|vob|rm|rmvb|divx)$/;

/** MIME equivalents, for extension-less URLs typed only by imeta `m`. */
const UNPLAYABLE_VIDEO_MIME =
  /^video\/(x-msvideo|vnd\.avi|avi|msvideo|x-ms-wmv|x-ms-asf|x-flv|flv|mpeg|vnd\.rn-realvideo|divx)$/;

/** Whether a video should render as a download card instead of `<video>`; checks MIME, then extension. */
export function isUnplayableVideo(url: string, mime?: string): boolean {
  if (mime && UNPLAYABLE_VIDEO_MIME.test(mime.toLowerCase())) return true;
  let ext = "";
  try {
    const seg = new URL(url).pathname.split("/").pop() ?? "";
    const dot = seg.lastIndexOf(".");
    if (dot > 0 && dot < seg.length - 1) ext = seg.slice(dot + 1).toLowerCase();
  } catch { /* ignore */ }
  return ext ? UNPLAYABLE_VIDEO_EXTS.test(ext) : false;
}

/** Infers a MIME type from a file extension string (lowercase). */
export function mimeFromExt(ext: string): string {
  switch (ext) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png':  return 'image/png';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg':  return 'image/svg+xml';
    case 'avif': return 'image/avif';
    case 'mp4':  return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'mov':  return 'video/quicktime';
    case 'qt':   return 'video/quicktime';
    case 'avi':  return 'video/x-msvideo';
    case 'mkv':  return 'video/x-matroska';
    case 'flv':  return 'video/x-flv';
    case 'mp3':  return 'audio/mpeg';
    case 'mpga': return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'ogg':  return 'audio/ogg';
    case 'oga':  return 'audio/ogg';
    case 'flac': return 'audio/flac';
    case 'm4a':  return 'audio/mp4';
    case 'aac':  return 'audio/aac';
    case 'opus': return 'audio/opus';
    case 'weba': return 'audio/webm';
    case 'xdc':  return WEBXDC_MIME;
    default:     return 'application/octet-stream';
  }
}

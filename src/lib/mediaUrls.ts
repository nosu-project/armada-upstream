/** Image extensions rendered inline. */
export const IMAGE_EXTS = 'jpg|jpeg|png|gif|webp|svg|avif';

/** Video extensions rendered as players. */
export const VIDEO_EXTS = 'mp4|webm|mov|qt|avi|mkv|flv';

/** Audio extensions rendered as players. Includes the mime-db-first synonyms
 *  Blossom servers pick when naming content-addressed blobs from the upload's
 *  Content-Type (audio/mpeg → `.mpga`, audio/ogg → `.oga`, audio/webm → `.weba`). */
export const AUDIO_EXTS = 'mp3|mpga|wav|ogg|oga|flac|m4a|aac|opus|weba';

/** All media extensions (image + video + audio + webxdc). */
export const ALL_MEDIA_EXTS = `${IMAGE_EXTS}|${VIDEO_EXTS}|${AUDIO_EXTS}|xdc`;

/** Matches image URLs. */
export const IMAGE_URL_REGEX = new RegExp(
  `https?:\\/\\/[^\\s]+\\.(${IMAGE_EXTS})(\\?[^\\s]*)?`,
  'i',
);

/** Matches video URLs. */
export const VIDEO_URL_REGEX = new RegExp(
  `https?:\\/\\/[^\\s]+\\.(${VIDEO_EXTS})(\\?[^\\s]*)?`,
  'gi',
);

/** Matches audio URLs. */
export const AUDIO_URL_REGEX = new RegExp(
  `https?:\\/\\/[^\\s]+\\.(${AUDIO_EXTS})(\\?[^\\s]*)?`,
  'gi',
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
 * Non-global variant of IMETA_MEDIA_URL_REGEX, safe for `.test()` calls.
 *
 * IMPORTANT: Never use the global (`g`) IMETA_MEDIA_URL_REGEX with `.test()` —
 * the global flag makes `lastIndex` stateful, so repeated `.test()` calls
 * (e.g. inside `.find()` or `.filter()`) will alternate between matching and
 * not matching, causing every other URL to be misclassified.
 */
export const IMETA_MEDIA_URL_TEST_REGEX = new RegExp(
  IMETA_MEDIA_URL_REGEX.source,
  'i',
);

/**
 * Hosts whose "video" files are really silent, looping GIF renditions. Other
 * clients' GIF pickers (Tenor/Giphy) share the `.mp4`/`.webm` rendition rather
 * than the `.gif`, so a plain `<video controls>` renders a GIF as a heavy,
 * chrome-laden clip that doesn't autoplay. Matched against the URL host with a
 * leading-dot boundary so only these domains and their subdomains qualify
 * (`media.tenor.com`, `media1.giphy.com`), never a lookalike like `nottenor.com`.
 */
const GIF_VIDEO_HOST_REGEX = /(^|\.)(tenor\.com|giphy\.com)$/i;

/**
 * Whether a media URL should present as a GIF (autoplay, loop, muted, no
 * controls) rather than a video. True for known GIF-CDN hosts and for the
 * `.gif.mp4` / `.gif.webm` filename convention some pickers emit. A real `.gif`
 * is already an `<img>`, so this only matters for the video render path.
 */
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
    case 'xdc':  return 'application/x-webxdc';
    default:     return 'application/octet-stream';
  }
}


/** Extracts all video URLs from a string. */
export function extractVideoUrls(content: string): string[] {
  return content.match(new RegExp(VIDEO_URL_REGEX.source, 'gi')) ?? [];
}

/** Extracts all audio URLs from a string. */
export function extractAudioUrls(content: string): string[] {
  return content.match(new RegExp(AUDIO_URL_REGEX.source, 'gi')) ?? [];
}

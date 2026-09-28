// Shared by share.ts and downloadFile.ts so neither imports the other (avoids a module-init cycle).

/** Human-readable byte size (1024-based). Empty string for a non-size. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Base64-encode bytes in chunks (avoids arg-count limits on large inputs). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** File extension for a MIME type, when we can infer a common one. */
export function extForMime(mime: string | undefined): string {
  switch ((mime ?? "").toLowerCase().split(";")[0].trim()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/avif":
      return ".avif";
    case "image/heic":
      return ".heic";
    case "image/svg+xml":
      return ".svg";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    default:
      return "";
  }
}

/**
 * Identify a bitmap from its leading bytes. The declared type is often missing
 * (no `m` tag, extensionless Blossom URL), and untyped files preview badly or
 * are refused by share targets.
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, len: number) =>
    String.fromCharCode(...bytes.subarray(start, start + len));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ascii(0, 4) === "GIF8") return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "mif1") return "image/heic";
  }
  return undefined;
}

/**
 * Reduce an untrusted string to a bare, length-capped filename — never a path.
 * Native filesystem plugins don't containment-check paths, so `..`, separators,
 * control chars and leading dots are stripped here.
 */
export function safeFilename(name: string | undefined): string {
  if (!name) return "download";
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return cleaned || "download";
}

/**
 * Filename from a URL's last path segment (plus MIME-derived extension if
 * missing). Goes through {@link safeFilename} because percent-decoding can
 * reintroduce `../` that URL parsing left encoded.
 */
export function filenameFromUrl(url: string, mime?: string): string {
  let base = "download";
  try {
    const { pathname } = new URL(url);
    const segment = pathname.split("/").filter(Boolean).pop();
    if (segment) base = safeFilename(decodeURIComponent(segment));
  } catch {
    // fall through to the generic name
  }
  if (!/\.[a-z0-9]{2,4}$/i.test(base)) base += extForMime(mime);
  return base;
}

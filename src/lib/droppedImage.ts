import { extForMime } from "@/lib/fileBytes";
import { proxyMediaUrl, type MediaPolicy } from "@/lib/mediaPolicy";

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'" };

function decodeAttr(value: string): string {
  return value.replace(/&(amp|quot|apos|lt|gt|#39);/g, (_m, name: string) => ENTITIES[name]);
}

/**
 * The source of an `<img>` dragged from a page (this one included), which
 * browsers hand over as `text/uri-list` + `text/html` with no file. Undefined
 * for any other drag — a link wrapping an image names the link, not the image.
 */
export function draggedImageSource(dt: Pick<DataTransfer, "getData">): string | undefined {
  const uri = dt.getData("text/uri-list")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  if (!uri || !/^(?:https?|blob|data):/i.test(uri)) return undefined;
  const html = dt.getData("text/html");
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if (decodeAttr(match[1] ?? match[2] ?? "") === uri) return uri;
  }
  return undefined;
}

/**
 * Read a dropped image back as a file to upload. A remote source goes through
 * the media policy, so a drop from another site fetches what an `<img>` here would.
 */
export async function fetchDroppedImage(src: string, policy: MediaPolicy): Promise<File> {
  const res = await fetch(proxyMediaUrl(src, policy.proxy), { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("Dropped item is not an image");
  return new File([blob], `image${extForMime(blob.type)}`, { type: blob.type });
}

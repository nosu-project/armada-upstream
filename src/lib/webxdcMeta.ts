import { unzipSync } from "fflate";
import { parse as parseTOML } from "smol-toml";

/** Metadata extracted from a webxdc `.xdc` ZIP archive. */
export interface WebxdcMeta {
  /** App name from manifest.toml, or undefined if missing. */
  name?: string;
  /** Icon as a File ready for upload, or undefined if missing. */
  iconFile?: File;
}

/** Extract the name (manifest.toml) and icon (icon.png, else icon.jpg) from a `.xdc` ZIP. */
export async function extractWebxdcMeta(file: File): Promise<WebxdcMeta> {
  const buf = await file.arrayBuffer();
  const unzipped = unzipSync(new Uint8Array(buf));

  const meta: WebxdcMeta = {};

  const manifestBytes = unzipped["manifest.toml"];
  if (manifestBytes) {
    const text = new TextDecoder().decode(manifestBytes);
    try {
      const manifest = parseTOML(text);
      if (typeof manifest.name === "string") {
        meta.name = manifest.name;
      }
    } catch {
      // ignore malformed TOML
    }
  }

  const iconPng = unzipped["icon.png"];
  const iconJpg = unzipped["icon.jpg"];
  const iconBytes = iconPng ?? iconJpg;

  if (iconBytes && iconBytes.length > 0) {
    const isPng = !!iconPng;
    const mime = isPng ? "image/png" : "image/jpeg";
    const ext = isPng ? ".png" : ".jpg";
    meta.iconFile = new File([iconBytes as BlobPart], `icon${ext}`, { type: mime });
  }

  return meta;
}

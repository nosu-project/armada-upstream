import { encode as blurhashEncode } from "blurhash";

/** For an image File: `{ dim: "WxH", blurhash }`, decoded at ≤64px wide. */
export async function getImageMeta(file: File): Promise<{ dim?: string; blurhash?: string }> {
  if (!file.type.startsWith("image/")) return {};
  try {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });

      const naturalWidth = img.naturalWidth;
      const naturalHeight = img.naturalHeight;
      if (!naturalWidth || !naturalHeight) return {};

      const dim = `${naturalWidth}x${naturalHeight}`;

      const SAMPLE_W = 64;
      const scale = SAMPLE_W / naturalWidth;
      const sampleH = Math.max(1, Math.round(naturalHeight * scale));

      const canvas = document.createElement("canvas");
      canvas.width = SAMPLE_W;
      canvas.height = sampleH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { dim };

      ctx.drawImage(img, 0, 0, SAMPLE_W, sampleH);
      const { data } = ctx.getImageData(0, 0, SAMPLE_W, sampleH);

      const blurhash = blurhashEncode(data, SAMPLE_W, sampleH, 4, 3);
      return { dim, blurhash };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return {};
  }
}

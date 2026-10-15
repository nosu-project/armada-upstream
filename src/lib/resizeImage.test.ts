import { afterEach, describe, expect, it, vi } from "vitest";

import { makeImageThumb, resizeImage } from "./resizeImage";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal PNG framing (CRCs zeroed; nothing here reads them) with one tEXt chunk. */
function pngWithTextChunk(keyword: string, payload: string) {
  const encoder = new TextEncoder();
  const keywordBytes = encoder.encode(keyword);
  const payloadBytes = encoder.encode(payload);
  const data = new Uint8Array(keywordBytes.length + 1 + payloadBytes.length);
  data.set(keywordBytes, 0);
  data.set(payloadBytes, keywordBytes.length + 1);
  const bytes: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const push = (chunkType: string, chunkData: Uint8Array) => {
    bytes.push(
      (chunkData.length >>> 24) & 0xff, (chunkData.length >>> 16) & 0xff,
      (chunkData.length >>> 8) & 0xff, chunkData.length & 0xff,
    );
    for (let i = 0; i < 4; i++) bytes.push(chunkType.charCodeAt(i));
    for (const b of chunkData) bytes.push(b);
    bytes.push(0, 0, 0, 0);
  };
  push("IHDR", new Uint8Array(13));
  push("tEXt", data);
  push("IEND", new Uint8Array(0));
  return new Uint8Array(bytes);
}

function b64(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

function stubBitmap(width: number, height: number) {
  vi.stubGlobal("createImageBitmap", async () => ({ width, height, close: () => undefined }));
}

describe("resizeImage", () => {
  it("decodes without imageOrientation where the WebView rejects \"from-image\"", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("createImageBitmap", async (_file: Blob, options?: ImageBitmapOptions) => {
      calls.push(options);
      if (options?.imageOrientation) {
        throw new TypeError("The provided value 'from-image' is not a valid enum value of type ImageOrientation.");
      }
      return { width: 64, height: 48, close: () => undefined };
    });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "dot.png", { type: "image/png" });

    const out = await resizeImage(file);

    expect(out).toEqual({ file, dimensions: "64x48" });
    expect(calls).toEqual([{ imageOrientation: "from-image" }, undefined]);
  });

  it("does not swallow a decode failure that isn't the option", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new DOMException("The source image could not be decoded.", "InvalidStateError");
    });
    const file = new File([new Uint8Array([1, 2, 3])], "bad.png", { type: "image/png" });

    await expect(resizeImage(file)).rejects.toThrow("could not be decoded");
  });

  it("uploads an oversized character-card PNG byte-for-byte — the payload is the file", async () => {
    // 2752px high, so every normal photo would be re-encoded and its tEXt chunk lost.
    stubBitmap(1835, 2752);
    const png = pngWithTextChunk("chara", b64({
      spec: "chara_card_v2",
      data: { name: "Keqing", description: "The Yuheng of the Liyue Qixing." },
    }));
    const file = new File([png], "card.png", { type: "image/png" });

    const out = await resizeImage(file);

    expect(out.file).toBe(file);
    expect(out.dimensions).toBe("1835x2752");
  });

  it("still re-encodes an oversized PNG that carries no card", async () => {
    stubBitmap(4000, 3000);
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => undefined }),
          toBlob: (cb: (b: Blob) => void) => cb(new Blob([new Uint8Array(10)], { type: "image/jpeg" })),
        };
        return canvas;
      },
    });
    const file = new File([pngWithTextChunk("Comment", "just a note")], "photo.png", { type: "image/png" });

    const out = await resizeImage(file);

    // The canvas path ran: same-shape scaled file, re-typed by the encoder.
    expect(out.file).not.toBe(file);
    expect(out.dimensions).toBe("1920x1440");
  });
});

describe("makeImageThumb", () => {
  function stubCanvas(blob: Blob) {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 4000, height: 3000, close: () => undefined }));
    const drawn: number[][] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => drawn.push([canvas.width, canvas.height]) }),
          toBlob: (cb: (b: Blob) => void) => cb(blob),
        };
        return canvas;
      },
    });
    return drawn;
  }

  const photo = (size: number, type = "image/jpeg") =>
    new File([new Uint8Array(size)], "photo.jpg", { type });

  it("scales the longest side to the preview size", async () => {
    const drawn = stubCanvas(new Blob([new Uint8Array(40_000)], { type: "image/jpeg" }));
    const thumb = await makeImageThumb(photo(3_000_000));
    expect(drawn).toEqual([[768, 576]]);
    expect(thumb?.type).toBe("image/jpeg");
    expect(thumb?.size).toBe(40_000);
  });

  it("skips a preview that would not save much", async () => {
    stubCanvas(new Blob([new Uint8Array(60_000)], { type: "image/jpeg" }));
    expect(await makeImageThumb(photo(100_000))).toBeUndefined();
  });

  it("skips an image that may be transparent where WebP can't be encoded", async () => {
    // A browser without a WebP encoder hands back PNG.
    stubCanvas(new Blob([new Uint8Array(40_000)], { type: "image/png" }));
    expect(await makeImageThumb(photo(3_000_000, "image/png"))).toBeUndefined();
  });
});

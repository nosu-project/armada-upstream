import { afterEach, describe, expect, it, vi } from "vitest";

import { makeImageThumb, resizeImage } from "./resizeImage";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

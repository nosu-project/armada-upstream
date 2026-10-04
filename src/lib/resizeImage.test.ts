import { afterEach, describe, expect, it, vi } from "vitest";

import { resizeImage } from "./resizeImage";

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

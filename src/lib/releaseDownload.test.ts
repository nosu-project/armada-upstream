import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => [] as { filename: string; bytes: Uint8Array }[]);
vi.mock("@/lib/downloadFile", () => ({
  downloadBinaryFile: async (filename: string, bytes: Uint8Array) => { saved.push({ filename, bytes }); },
}));

import { HashMismatchError, downloadArtifact } from "./releaseDownload";

const payload = new TextEncoder().encode("armada build bytes");
const hash = createHash("sha256").update(payload).digest("hex");

function serve(body: Uint8Array, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body as BlobPart, {
    status,
    headers: { "content-length": String(body.byteLength) },
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  saved.length = 0;
});

describe("downloadArtifact", () => {
  it("saves the bytes under the asset's filename, not the URL's hash", async () => {
    serve(payload);
    const progress: number[] = [];
    await downloadArtifact(
      { url: `https://blossom.example/${hash}`, hash, size: payload.byteLength, filename: "Armada-v1.0.0.apk" },
      (fraction) => progress.push(fraction),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].filename).toBe("Armada-v1.0.0.apk");
    expect(Array.from(saved[0].bytes)).toEqual(Array.from(payload));
    expect(progress.at(-1)).toBe(1);
  });

  it("refuses to save bytes that don't match the asset's hash", async () => {
    serve(new TextEncoder().encode("something else"));
    await expect(downloadArtifact({ url: "https://blossom.example/x", hash, size: 0, filename: "a.apk" }))
      .rejects.toBeInstanceOf(HashMismatchError);
    expect(saved).toHaveLength(0);
  });

  it("throws on an HTTP error", async () => {
    serve(new Uint8Array(), 404);
    await expect(downloadArtifact({ url: "https://blossom.example/x", hash, size: 0, filename: "a.apk" }))
      .rejects.toThrow("HTTP 404");
    expect(saved).toHaveLength(0);
  });
});

import { downloadBinaryFile } from "@/lib/downloadFile";
import type { ReleaseArtifact } from "@/lib/releases";

/** The bytes the server sent are not the ones the signed asset event names. */
export class HashMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`sha256 mismatch: expected ${expected}, got ${actual}`);
    this.name = "HashMismatchError";
  }
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch an artifact, check it against its asset's `x` hash, and save it under
 * the asset's filename. A Blossom URL is named by its hash and sends no
 * Content-Disposition, and `<a download>` is ignored cross-origin, so a plain
 * link saves the file as its hash.
 */
export async function downloadArtifact(
  artifact: Pick<ReleaseArtifact, "url" | "hash" | "size" | "filename">,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const response = await fetch(artifact.url);
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);

  const total = Number(response.headers.get("content-length")) || artifact.size;
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total) onProgress?.(Math.min(received / total, 1));
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (artifact.hash) {
    const actual = toHex(await crypto.subtle.digest("SHA-256", bytes));
    if (actual !== artifact.hash) throw new HashMismatchError(artifact.hash, actual);
  }

  await downloadBinaryFile(artifact.filename, bytes);
}

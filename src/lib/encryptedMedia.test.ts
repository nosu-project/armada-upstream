import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decryptAttachmentToObjectURL,
  decryptBytes,
  encryptBytes,
  encryptFileWithParams,
  fetchCapped,
  FileTooLargeError,
  peekAttachmentObjectURL,
  readCapped,
  verifyPlaintextHash,
} from "./encryptedMedia";

/**
 * The fetch-side half of cross-server fallback: given the same blob on several
 * hosts, a dead one costs a round-trip, not the attachment. Two failures are
 * final — an abort, and a blob too large, which is exactly as large everywhere.
 */
describe("fetchCapped", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const calls = () => fetchMock.mock.calls.map((c) => String(c[0]));
  afterEach(() => vi.unstubAllGlobals());

  function stub(impl: (url: string) => Promise<Response>) {
    fetchMock.mockReset();
    fetchMock.mockImplementation((input) => impl(String(input)));
    vi.stubGlobal("fetch", fetchMock);
  }

  it("moves to the next host on a network error and on a non-2xx", async () => {
    stub(async (url) => {
      if (url === "https://one/x") throw new TypeError("Failed to fetch");
      if (url === "https://two/x") return new Response(null, { status: 502 });
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const out = await fetchCapped(["https://one/x", "https://two/x", "https://three/x"]);
    expect(Array.from(new Uint8Array(out))).toEqual([1, 2, 3]);
    expect(calls()).toEqual(["https://one/x", "https://two/x", "https://three/x"]);
  });

  it("surfaces the last error once every host has failed", async () => {
    stub(async () => new Response(null, { status: 404 }));
    await expect(fetchCapped(["https://one/x", "https://two/x"])).rejects.toThrow(/HTTP 404/);
    expect(calls()).toEqual(["https://one/x", "https://two/x"]);
  });

  it("stops at a blob that is too large rather than asking every mirror", async () => {
    stub(async () => new Response(new Uint8Array(100), { headers: { "content-length": "100" } }));
    await expect(fetchCapped(["https://one/x", "https://two/x"], { maxBytes: 10 })).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    expect(calls()).toEqual(["https://one/x"]);
  });

  it("stops on abort", async () => {
    const controller = new AbortController();
    stub(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(fetchCapped(["https://one/x", "https://two/x"], { signal: controller.signal })).rejects.toThrow();
    expect(calls()).toEqual(["https://one/x"]);
  });

  it("still takes a single URL", async () => {
    stub(async () => new Response(new Uint8Array([9])));
    const out = await fetchCapped("https://one/x");
    expect(Array.from(new Uint8Array(out))).toEqual([9]);
  });
});

/**
 * Interop guarantees for client-encrypted Blossom attachments (Vector / 0xChat):
 * a 32-byte key + 16-byte (0xChat-compatible) nonce, ciphertext laid out as
 * `ciphertext || 16-byte GCM tag`, round-tripping via the imeta-carried params.
 *
 * These exercise the raw byte crypto directly (jsdom's Blob/File mangle binary
 * data, so File-level round-trips can't be asserted reliably here; the File
 * wrapper just reads `file.arrayBuffer()` and forwards to `encryptBytes`).
 */
describe("encryptedMedia crypto", () => {
  it("round-trips plaintext through encrypt → decrypt", async () => {
    const key = "a".repeat(64);
    const nonce = "b".repeat(32); // 16 bytes
    const plaintext = new TextEncoder().encode("the quick brown fox jumps over 13 lazy dogs");

    const ciphertext = await encryptBytes(plaintext, key, nonce);
    // ciphertext = plaintext + 16-byte GCM tag
    expect(ciphertext.length).toBe(plaintext.length + 16);

    const decrypted = await decryptBytes(ciphertext, key, nonce);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it("fails to decrypt with the wrong key (auth tag check)", async () => {
    const nonce = "b".repeat(32);
    const ciphertext = await encryptBytes(new Uint8Array([1, 2, 3]), "a".repeat(64), nonce);
    await expect(decryptBytes(ciphertext, "c".repeat(64), nonce)).rejects.toThrow();
  });

  it("uses a 16-byte nonce (0xChat / Vector compatible), not 12", async () => {
    // A 16-byte nonce must be accepted by AES-GCM here (WebCrypto allows any IV
    // length); this is what makes Vector-originated blobs decryptable.
    const key = "a".repeat(64);
    const nonce16 = "b".repeat(32);
    const data = new Uint8Array([9, 8, 7, 6, 5]);
    const ct = await encryptBytes(data, key, nonce16);
    expect(Array.from(await decryptBytes(ct, key, nonce16))).toEqual(Array.from(data));
  });
});

/**
 * NIP-17 specifies that a `thumb` (and any `fallback` source) is "encrypted
 * with the same key, nonce" as the file it accompanies, so the message's
 * single decryption-key/nonce pair decrypts every blob of the attachment.
 */
describe("encryptFileWithParams", () => {
  const key = "a".repeat(64);
  const nonce = "b".repeat(32);

  /** jsdom's File has no `arrayBuffer()`; supply just that. */
  function file(content: string, name: string, type?: string): File {
    const f = new File([content], name, type ? { type } : undefined);
    Object.defineProperty(f, "arrayBuffer", {
      value: async () => new TextEncoder().encode(content).buffer,
    });
    return f;
  }

  it("encrypts under the supplied key and nonce", async () => {
    const result = await encryptFileWithParams(file("video", "clip.mp4"), key, nonce);
    expect(result.key).toBe(key);
    expect(result.nonce).toBe(nonce);
  });

  it("gives a video and its thumbnail identical params", async () => {
    const video = await encryptFileWithParams(file("video", "clip.mp4"), key, nonce);
    const thumb = await encryptFileWithParams(file("poster", "clip.jpg"), video.key, video.nonce);

    expect(thumb.key).toBe(video.key);
    expect(thumb.nonce).toBe(video.nonce);
  });

  it("keeps the plaintext MIME on the ciphertext file", async () => {
    // Blossom servers commonly reject application/octet-stream.
    const thumb = await encryptFileWithParams(file("poster", "clip.jpg", "image/jpeg"), key, nonce);
    expect(thumb.file.type).toBe("image/jpeg");
  });
});

/**
 * AES-GCM authenticates the whole message, so it can't be streamed: decrypting
 * necessarily holds ciphertext and plaintext at once. Nothing about a message
 * scrolling into view is an instruction to allocate, and the size is the
 * SENDER's choice, so the read is capped before the bytes are resident — not
 * after, which is the check that has already spent what it was guarding.
 */
describe("readCapped", () => {
  /** A Response with a real streaming body, in `chunkSize` pieces. */
  function streamed(bytes: Uint8Array, opts: { declare?: number | null; chunkSize?: number } = {}): Response {
    const chunkSize = opts.chunkSize ?? (bytes.byteLength || 1);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });
    const headers = new Headers();
    const declared = opts.declare === undefined ? bytes.byteLength : opts.declare;
    if (declared !== null) headers.set("content-length", String(declared));
    return new Response(body, { headers });
  }

  it("reads a body that fits", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await readCapped(streamed(bytes), 1024);
    expect(Array.from(new Uint8Array(out))).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses on Content-Length before consuming the body", async () => {
    // The point of checking the header first is that an oversized blob costs
    // nothing: we never open a reader on it, so nothing is buffered.
    const res = streamed(new Uint8Array(4), { declare: 999999 });
    const getReader = vi.spyOn(res.body!, "getReader");
    await expect(readCapped(res, 1024)).rejects.toBeInstanceOf(FileTooLargeError);
    expect(getReader).not.toHaveBeenCalled();
  });

  it("stops a server that under-reports Content-Length", async () => {
    // The header is a promise from the same party serving the bytes, so the
    // running count is what actually enforces the cap.
    const res = streamed(new Uint8Array(400), { declare: 10, chunkSize: 50 });
    await expect(readCapped(res, 100)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("enforces the cap with no Content-Length at all", async () => {
    const res = streamed(new Uint8Array(400), { declare: null, chunkSize: 50 });
    await expect(readCapped(res, 100)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("reports the size it refused", async () => {
    const res = streamed(new Uint8Array(8), { declare: 9000 });
    await expect(readCapped(res, 10)).rejects.toMatchObject({ byteSize: 9000 });
  });

  it("hands back only what arrived when the body is shorter than declared", async () => {
    const res = streamed(new Uint8Array([7, 7, 7]), { declare: 10 });
    const out = await readCapped(res, 1024);
    expect(out.byteLength).toBe(3);
  });
});

/**
 * The key travels in the event, so anyone who can read the message can decrypt
 * — but the blob sits on a media server nobody authenticated. `ox` is what
 * makes a swapped blob fail closed instead of rendering.
 */
describe("verifyPlaintextHash", () => {
  const bytes = new TextEncoder().encode("the real file");

  it("accepts bytes matching `ox`", () => {
    expect(() => verifyPlaintextHash(bytes, bytesToHex(sha256(bytes)))).not.toThrow();
  });

  it("accepts an uppercase `ox`", () => {
    expect(() => verifyPlaintextHash(bytes, bytesToHex(sha256(bytes)).toUpperCase())).not.toThrow();
  });

  it("rejects a swapped blob", () => {
    const other = new TextEncoder().encode("a different file");
    expect(() => verifyPlaintextHash(other, bytesToHex(sha256(bytes)))).toThrow(/ox/);
  });

  it("skips verification when the sender published no `ox`", () => {
    // A forward may not carry one; refusing those would break real messages.
    expect(() => verifyPlaintextHash(bytes, undefined)).not.toThrow();
  });
});

/**
 * The synchronous half of the attachment cache, which is what lets a remount
 * paint on its first frame. Without it a channel switch spends a placeholder
 * commit plus a post-load height change on every attachment whose bytes never
 * left memory — the async API can only ever deliver in a microtask, however
 * warm the cache is.
 */
describe("peekAttachmentObjectURL", () => {
  const key = "a".repeat(64);
  const nonce = "b".repeat(32);
  let created = 0;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Answer every fetch with ciphertext, and mint distinguishable object URLs.
   *
   * jsdom implements neither `createObjectURL` nor `revokeObjectURL`, so they
   * have to be supplied rather than spied on — as a SUBCLASS, which shadows the
   * two statics while leaving `new URL()` and the rest of them intact. (An
   * object literal spread from `URL` inherits none of them: its statics are
   * non-enumerable.)
   */
  async function serve(): Promise<void> {
    const ciphertext = await encryptBytes(new TextEncoder().encode("frame bytes"), key, nonce);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ciphertext)));
    class StubURL extends URL {
      static override createObjectURL = () => `blob:stub-${++created}`;
      static override revokeObjectURL = () => {};
    }
    vi.stubGlobal("URL", StubURL);
  }

  it("misses before the attachment has ever been decrypted", async () => {
    await serve();
    expect(peekAttachmentObjectURL("https://blossom.example/a", { algorithm: "aes-gcm", key, nonce }))
      .toBeUndefined();
  });

  it("returns the same object URL the async path resolved to", async () => {
    const url = "https://blossom.example/b";
    await serve();
    const enc = { algorithm: "aes-gcm", key, nonce };

    const resolved = await decryptAttachmentToObjectURL(url, enc, "image/jpeg");

    // The whole point: no await, no microtask — a caller rendering this frame
    // can put it straight into an `<img src>`.
    expect(peekAttachmentObjectURL(url, enc)).toBe(resolved);
  });

  it("misses while the decrypt is still in flight", async () => {
    const url = "https://blossom.example/c";
    await serve();
    const enc = { algorithm: "aes-gcm", key, nonce };

    const pending = decryptAttachmentToObjectURL(url, enc, "image/jpeg");
    // An entry exists, but it holds only a promise — reporting a URL here would
    // hand the caller an empty src.
    expect(peekAttachmentObjectURL(url, enc)).toBeUndefined();
    await pending;
    expect(peekAttachmentObjectURL(url, enc)).toBeDefined();
  });

  it("keys on the crypto params, not the url alone", async () => {
    const url = "https://blossom.example/d";
    await serve();
    await decryptAttachmentToObjectURL(url, { algorithm: "aes-gcm", key, nonce }, "image/jpeg");

    // Same blob, different nonce: a different plaintext, so it must not hit.
    expect(peekAttachmentObjectURL(url, { algorithm: "aes-gcm", key, nonce: "c".repeat(32) }))
      .toBeUndefined();
  });
});

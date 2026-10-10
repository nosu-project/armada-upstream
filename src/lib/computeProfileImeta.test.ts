import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completeProfileImetaTags, describeImageUrl } from "./computeProfileImeta";

vi.mock("@/lib/imageProbe", () => ({
  probeImage: vi.fn(async (blob: Blob) => (blob.size > 0 ? { dim: "400x400", blurhash: "LEHV6nWB2yk8" } : {})),
}));

const BYTES = new TextEncoder().encode("not really a jpeg");
/** sha256 of {@link BYTES}. */
let HASH = "";

const DIRECT = { proxy: "" };
const PROXIED = { proxy: "https://proxy.example/?url={href}" };

function respond(body: Uint8Array, type = "image/jpeg") {
  return new Response(new Blob([body as BlobPart], { type }), { status: 200 });
}

beforeEach(async () => {
  HASH = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", BYTES)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("describeImageUrl", () => {
  it("describes the downloaded bytes under the original URL", async () => {
    const fetchMock = vi.fn(async (_input: string) => respond(BYTES));
    vi.stubGlobal("fetch", fetchMock);
    const url = `https://blossom.example/${HASH}.jpg`;
    expect(await describeImageUrl(url, DIRECT)).toEqual([
      "imeta",
      `url ${url}`,
      "m image/jpeg",
      `x ${HASH}`,
      `size ${BYTES.length}`,
      "dim 400x400",
      "blurhash LEHV6nWB2yk8",
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe(url);
  });

  it("fetches through the media proxy but names the original URL", async () => {
    const fetchMock = vi.fn(async (_input: string) => respond(BYTES));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://cdn.example/me.jpg";
    const tag = await describeImageUrl(url, PROXIED);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://proxy.example/?url=${encodeURIComponent(url)}`);
    expect(tag).toContain(`url ${url}`);
  });

  it("omits a non-image content type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(BYTES, "application/octet-stream")));
    const tag = await describeImageUrl("https://cdn.example/me", DIRECT);
    expect(tag?.some((part) => part.startsWith("m "))).toBe(false);
  });

  it("refuses bytes that don't match a content-addressed URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(BYTES)));
    expect(await describeImageUrl(`https://blossom.example/${"0".repeat(64)}.jpg`, DIRECT)).toBeUndefined();
  });

  it("gives up on a failed fetch, an undecodable image, or a local address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(await describeImageUrl("https://cdn.example/a.jpg", DIRECT)).toBeUndefined();

    vi.stubGlobal("fetch", vi.fn(async () => respond(new Uint8Array())));
    expect(await describeImageUrl("https://cdn.example/a.jpg", DIRECT)).toBeUndefined();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await describeImageUrl("http://192.168.1.10/a.jpg", DIRECT)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("completeProfileImetaTags", () => {
  const PIC = "https://cdn.example/pic.jpg";
  const BANNER = "https://cdn.example/banner.jpg";

  it("keeps described images and downloads only the rest, in field order", async () => {
    const fetchMock = vi.fn(async (_input: string) => respond(BYTES));
    vi.stubGlobal("fetch", fetchMock);
    const tags = await completeProfileImetaTags(
      { picture: PIC, banner: BANNER },
      [["imeta", `url ${BANNER}`, "m image/png"], ["imeta", "url https://cdn.example/old.jpg"]],
      DIRECT,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tags.map((t) => t[1])).toEqual([`url ${PIC}`, `url ${BANNER}`]);
    expect(tags[1]).toEqual(["imeta", `url ${BANNER}`, "m image/png"]);
  });

  it("publishes without a tag when the download fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("CORS"); }));
    expect(await completeProfileImetaTags({ picture: PIC }, [], DIRECT)).toEqual([]);
  });

  it("does nothing when there are no images", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await completeProfileImetaTags({ name: "x" } as never, [], DIRECT)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops waiting after the timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
      const pending = completeProfileImetaTags({ picture: PIC }, [], DIRECT);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

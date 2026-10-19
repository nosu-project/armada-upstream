import { afterEach, describe, expect, it, vi } from "vitest";

import { draggedImageSource, fetchDroppedImage } from "./droppedImage";

function transfer(data: Record<string, string>) {
  return { getData: (type: string) => data[type] ?? "" };
}

const PROXIED = "https://proxy.shakespeare.diy/?url=https%3A%2F%2Fa.example%2Fa.jpg%3F10&x=1";

describe("draggedImageSource", () => {
  it("returns the source of a dragged image", () => {
    const dt = transfer({
      "text/uri-list": PROXIED,
      "text/html": `<meta charset="utf-8"><img src="${PROXIED.replace("&", "&amp;")}" alt="">`,
    });
    expect(draggedImageSource(dt)).toBe(PROXIED);
  });

  it("ignores a link wrapping an image", () => {
    const dt = transfer({
      "text/uri-list": "https://example.com/page",
      "text/html": `<a href="https://example.com/page"><img src="https://example.com/a.png"></a>`,
    });
    expect(draggedImageSource(dt)).toBeUndefined();
  });

  it("ignores a plain link or text", () => {
    expect(draggedImageSource(transfer({ "text/uri-list": "https://example.com/" }))).toBeUndefined();
    expect(draggedImageSource(transfer({ "text/plain": "hello" }))).toBeUndefined();
  });

  it("refuses non-media schemes", () => {
    const dt = transfer({ "text/uri-list": "javascript:alert(1)", "text/html": `<img src="javascript:alert(1)">` });
    expect(draggedImageSource(dt)).toBeUndefined();
  });
});

describe("fetchDroppedImage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches a remote image through the proxy", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Blob(["x"], { type: "image/png" })));
    vi.stubGlobal("fetch", fetchMock);
    const file = await fetchDroppedImage("https://a.example/a.png", { proxy: "https://p.example/?url={href}" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://p.example/?url=https%3A%2F%2Fa.example%2Fa.png");
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("image.png");
  });

  it("does not re-wrap an already proxied source", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Blob(["x"], { type: "image/jpeg" })));
    vi.stubGlobal("fetch", fetchMock);
    await fetchDroppedImage(PROXIED, { proxy: "https://proxy.shakespeare.diy/?url={href}" });
    expect(fetchMock.mock.calls[0][0]).toBe(PROXIED);
  });

  it("rejects a response that is not an image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["<html>"], { type: "text/html" }))));
    await expect(fetchDroppedImage("https://a.example/", { proxy: "" })).rejects.toThrow();
  });
});

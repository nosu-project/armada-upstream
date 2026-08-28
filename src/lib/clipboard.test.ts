// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn((): string => "web");
const isNativePlatform = vi.fn((): boolean => false);
const pluginWrite = vi.fn(async (_options: { string?: string; image?: string; url?: string }) => {});

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => getPlatform(),
    isNativePlatform: () => isNativePlatform(),
  },
}));

vi.mock("@capacitor/clipboard", () => ({
  Clipboard: { write: (options: Parameters<typeof pluginWrite>[0]) => pluginWrite(options) },
}));

const { canCopyImages, writeClipboardImage } = await import("@/lib/clipboard");

/** A minimal ClipboardItem stand-in that just records the item map it's given. */
class FakeClipboardItem {
  constructor(public items: Record<string, Blob | Promise<Blob>>) {}
}

/** Point global `fetch` at a single fixed Blob response. */
function stubFetch(blob: Blob, ok = true) {
  const res = { ok, status: ok ? 200 : 500, blob: async () => blob };
  vi.stubGlobal("fetch", vi.fn(async () => res));
}

beforeEach(() => {
  getPlatform.mockClear().mockReturnValue("web");
  isNativePlatform.mockClear().mockReturnValue(false);
  pluginWrite.mockClear().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("canCopyImages", () => {
  it("is true on iOS", () => {
    getPlatform.mockReturnValue("ios");
    isNativePlatform.mockReturnValue(true);
    expect(canCopyImages()).toBe(true);
  });

  it("is false on Android (plugin would paste the data URL as text)", () => {
    getPlatform.mockReturnValue("android");
    isNativePlatform.mockReturnValue(true);
    expect(canCopyImages()).toBe(false);
  });

  it("is true on web when ClipboardItem and clipboard.write exist", () => {
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn() } });
    expect(canCopyImages()).toBe(true);
  });

  it("is false on web without ClipboardItem", () => {
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn() } });
    expect(canCopyImages()).toBe(false);
  });

  it("is false on web without clipboard.write (older Firefox)", () => {
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("navigator", { clipboard: {} });
    expect(canCopyImages()).toBe(false);
  });
});

describe("writeClipboardImage", () => {
  it("routes an iOS copy through the plugin as a data URL", async () => {
    getPlatform.mockReturnValue("ios");
    isNativePlatform.mockReturnValue(true);
    stubFetch(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));

    await writeClipboardImage("blob:whatever");

    expect(pluginWrite).toHaveBeenCalledTimes(1);
    const arg = pluginWrite.mock.calls[0][0];
    expect(arg.image).toMatch(/^data:image\/png;base64,/);
  });

  it("refuses on Android", async () => {
    getPlatform.mockReturnValue("android");
    isNativePlatform.mockReturnValue(true);
    await expect(writeClipboardImage("blob:x")).rejects.toThrow();
    expect(pluginWrite).not.toHaveBeenCalled();
  });

  it("writes a PNG blob straight to the web clipboard without re-encoding", async () => {
    const write = vi.fn(async (_items: FakeClipboardItem[]) => {});
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write } });
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    stubFetch(png);

    await writeClipboardImage("https://host/pic.png");

    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0][0][0] as FakeClipboardItem;
    await expect(item.items["image/png"]).resolves.toBe(png);
  });

  it("re-encodes a non-PNG image to PNG for the web clipboard", async () => {
    const write = vi.fn(async (_items: FakeClipboardItem[]) => {});
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write } });

    const encoded = new Blob([new Uint8Array([9])], { type: "image/png" });
    const bitmap = { width: 2, height: 2, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    const toBlob = vi.fn((cb: (b: Blob) => void) => cb(encoded));
    const getContext = vi.fn(() => ({ drawImage: vi.fn() }));
    vi.spyOn(document, "createElement").mockReturnValue({ getContext, toBlob } as unknown as HTMLCanvasElement);

    stubFetch(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));

    await writeClipboardImage("https://host/pic.jpg");

    const item = write.mock.calls[0][0][0] as FakeClipboardItem;
    await expect(item.items["image/png"]).resolves.toBe(encoded);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("rejects when the fetch fails", async () => {
    getPlatform.mockReturnValue("ios");
    isNativePlatform.mockReturnValue(true);
    stubFetch(new Blob([]), false);
    await expect(writeClipboardImage("blob:x")).rejects.toThrow();
  });
});

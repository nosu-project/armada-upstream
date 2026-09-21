// @vitest-environment jsdom
import { act, renderHook as renderHookBare } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppContext, type AppContextType } from "@/contexts/AppContext";
import { encryptBytes } from "@/lib/encryptedMedia";

import { useMediaWithFallback } from "./useMediaWithFallback";

/**
 * The server hook reads the context object itself, so the test supplies one.
 * No proxy, so these cases see the URLs as written: they are about the mirror
 * walk, and routing has its own suite in `useBlossomCandidates.test.ts` and
 * `mediaPolicy.test.ts`.
 */
const context = {
  config: {
    appBlossomServers: ["https://a.example/", "https://b.example/"],
    blossomServerMetadata: { servers: ["https://c.example/"], updatedAt: 0 },
    useAppBlossomServers: true,
    mediaProxies: [],
  },
  updateConfig: vi.fn(),
} as unknown as AppContextType;
const wrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(AppContext.Provider, { value: context }, children);
const renderHook = <T,>(cb: () => T) => renderHookBare(cb, { wrapper });

const KEY = "a".repeat(64);
const NONCE = "b".repeat(32);
const ENC = { algorithm: "aes-gcm" as const, key: KEY, nonce: NONCE };

/** A fresh hash per test, so the module-level decrypt cache never answers for another test's URL. */
let hash = 0;
function freshUrl(origin = "https://origin.example"): string {
  hash += 1;
  return `${origin}/${hash.toString(16).padStart(64, "0")}`;
}

/** The same blob on the three configured servers, in walk order. */
function mirrorsOf(url: string): string[] {
  const path = new URL(url).pathname;
  return [`https://a.example${path}`, `https://b.example${path}`, `https://c.example${path}`];
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // jsdom has no object URLs; the decrypt path ends in one.
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:decrypted", revokeObjectURL: () => {} }));
});
afterEach(() => vi.unstubAllGlobals());

describe("useMediaWithFallback — plain URL (element-driven walk)", () => {
  it("steps through the mirrors on onError, then fails", () => {
    const url = freshUrl();
    const { result } = renderHook(() => useMediaWithFallback({ url }));
    const src = () => (result.current.resolved.status === "ready" ? result.current.resolved.src : undefined);

    expect(src()).toBe(url);
    const seen: (string | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      act(() => result.current.onError());
      seen.push(src());
    }
    expect(seen).toEqual(mirrorsOf(url));
    expect(result.current.failed).toBe(false);

    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
    // Nothing was fetched: the element does the loading on this path.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails an ordinary URL after one error and retries from it on reset", () => {
    const url = "https://photos.example/pic.jpg";
    const { result } = renderHook(() => useMediaWithFallback({ url }));
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
    act(() => result.current.reset());
    expect(result.current.failed).toBe(false);
    expect(result.current.resolved).toEqual({ status: "ready", src: url });
  });

  it("puts declared fallbacks before derived mirrors", () => {
    const url = freshUrl();
    const { result } = renderHook(() =>
      useMediaWithFallback({ url, fallbacks: ["https://declared.example/blob"] }),
    );
    act(() => result.current.onError());
    expect(result.current.resolved).toEqual({ status: "ready", src: "https://declared.example/blob" });
    act(() => result.current.onError());
    expect(result.current.resolved).toEqual({ status: "ready", src: mirrorsOf(url)[0] });
  });
});

/**
 * The encrypted path is walked INSIDE the fetch, so a failure that lands
 * before React commits cannot strand it — the defect this replaces was an
 * effect on the status string, which never fired for error → error.
 */
describe("useMediaWithFallback — encrypted (fetch-driven walk)", () => {
  it("tries every mirror when each fails immediately, then fails", async () => {
    fetchMock.mockRejectedValue(new Error("net"));
    const url = freshUrl();
    const { result } = renderHook(() => useMediaWithFallback({ url, encryption: ENC }));

    await vi.waitFor(() => expect(result.current.failed).toBe(true));
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([url, ...mirrorsOf(url)]);
    expect(result.current.resolved.status).toBe("error");
  });

  it("resolves from the first mirror that answers", async () => {
    const url = freshUrl();
    const plaintext = new TextEncoder().encode("a real image");
    const ciphertext = await encryptBytes(plaintext, KEY, NONCE);
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.startsWith("https://origin.example")) throw new Error("down");
      if (u.startsWith("https://a.example")) return new Response(null, { status: 404 });
      return new Response(ciphertext.slice());
    });

    const { result } = renderHook(() => useMediaWithFallback({ url, encryption: ENC }));
    await vi.waitFor(() => expect(result.current.resolved.status).toBe("ready"));
    expect(result.current.failed).toBe(false);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([url, mirrorsOf(url)[0], mirrorsOf(url)[1]]);
  });

  it("fails closed, without fetching, for an encryption it cannot apply", () => {
    const url = freshUrl();
    const { result } = renderHook(() =>
      useMediaWithFallback({ url, encryption: { algorithm: "rot13" as never, key: "x", nonce: "y" } }),
    );
    expect(result.current.failed).toBe(true);
    expect(result.current.resolved.status).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches again on a manual reset after total failure", async () => {
    fetchMock.mockRejectedValue(new Error("net"));
    const url = freshUrl();
    const { result } = renderHook(() => useMediaWithFallback({ url, encryption: ENC }));
    await vi.waitFor(() => expect(result.current.failed).toBe(true));
    const before = fetchMock.mock.calls.length;

    act(() => result.current.reset());
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });
});

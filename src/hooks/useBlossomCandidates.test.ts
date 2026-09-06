// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { AppContext, type AppContextType } from "@/contexts/AppContext";
import { APP_BLOSSOM_SERVERS } from "@/lib/blossom";

import { useBlossomServers, useImageFallback, useSourceWalk } from "./useBlossomCandidates";

/** The hook reads the context object itself (so it survives without a provider), so the test supplies one. */
const context = {
  config: {
    appBlossomServers: ["https://a.example/", "https://b.example/"],
    blossomServerMetadata: { servers: ["https://c.example/"], updatedAt: 0 },
    useAppBlossomServers: true,
  },
  updateConfig: vi.fn(),
} as unknown as AppContextType;
const wrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(AppContext.Provider, { value: context }, children);

const HASH = "a".repeat(64);

describe("useBlossomServers", () => {
  it("reads the effective list from the app config", () => {
    const { result } = renderHook(() => useBlossomServers(), { wrapper });
    expect(result.current).toEqual(["https://a.example/", "https://b.example/", "https://c.example/"]);
  });

  it("falls back to the app defaults with no provider mounted", () => {
    // This sits under every avatar, so it has to render wherever one does.
    const { result } = renderHook(() => useBlossomServers());
    expect(result.current).toEqual(APP_BLOSSOM_SERVERS);
  });
});

/**
 * The index every cross-server walk is driven by. What matters is that it
 * cannot be stranded: it only moves on an explicit failure, it stops at the
 * end, and a new primary or a manual reset always starts it over.
 */
describe("useSourceWalk", () => {
  it("steps through the candidates on advance and fails past the last", () => {
    const list = ["https://one/x", "https://two/x", "https://three/x"];
    const { result } = renderHook(() => useSourceWalk(list));
    expect(result.current.src).toBe("https://one/x");
    expect(result.current.failed).toBe(false);

    act(() => result.current.advance());
    expect(result.current.src).toBe("https://two/x");
    act(() => result.current.advance());
    expect(result.current.src).toBe("https://three/x");
    expect(result.current.failed).toBe(false);

    act(() => result.current.advance());
    expect(result.current.failed).toBe(true);
    // Parks on the last candidate rather than running off the end.
    expect(result.current.src).toBe("https://three/x");
    act(() => result.current.advance());
    expect(result.current.failed).toBe(true);
  });

  it("reset returns to the first candidate and bumps the attempt", () => {
    const list = ["https://one/x", "https://two/x"];
    const { result } = renderHook(() => useSourceWalk(list));
    act(() => result.current.advance());
    act(() => result.current.advance());
    expect(result.current.failed).toBe(true);
    expect(result.current.attempt).toBe(0);

    act(() => result.current.reset());
    expect(result.current.src).toBe("https://one/x");
    expect(result.current.failed).toBe(false);
    expect(result.current.attempt).toBe(1);
  });

  it("starts over when the primary changes, in the same render", () => {
    // A reused component whose reference changed must not paint one frame at
    // the old index — that is how a fresh image inherited a stale failure.
    const { result, rerender } = renderHook(({ list }) => useSourceWalk(list), {
      initialProps: { list: ["https://one/x", "https://two/x"] },
    });
    act(() => result.current.advance());
    act(() => result.current.advance());
    expect(result.current.failed).toBe(true);

    rerender({ list: ["https://one/y", "https://two/y"] });
    expect(result.current.src).toBe("https://one/y");
    expect(result.current.failed).toBe(false);
  });

  it("is never failed with nothing to try", () => {
    const { result } = renderHook(() => useSourceWalk([]));
    expect(result.current.src).toBeUndefined();
    expect(result.current.failed).toBe(false);
    act(() => result.current.advance());
    expect(result.current.failed).toBe(false);
  });
});

describe("useImageFallback", () => {
  it("walks a content-addressed URL across the viewer's other servers", () => {
    const url = `https://origin.example/${HASH}.png`;
    const { result } = renderHook(() => useImageFallback(url), { wrapper });
    const seen = [result.current.src];
    for (let i = 0; i < 3; i++) {
      act(() => result.current.onError());
      seen.push(result.current.src);
    }
    expect(seen).toEqual([
      url,
      `https://a.example/${HASH}.png`,
      `https://b.example/${HASH}.png`,
      `https://c.example/${HASH}.png`,
    ]);
    expect(result.current.failed).toBe(false);
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
  });

  it("gives an ordinary URL one attempt", () => {
    const { result } = renderHook(() => useImageFallback("https://photos.example/me.jpg"), { wrapper });
    expect(result.current.src).toBe("https://photos.example/me.jpg");
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
  });

  it("renders nothing for no URL and never reports failure", () => {
    const { result } = renderHook(() => useImageFallback(undefined), { wrapper });
    expect(result.current.src).toBeUndefined();
    expect(result.current.failed).toBe(false);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { keepCallAwake } from "./callKeepAwake";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function fakeSentinel() {
  const s = { released: false, release: vi.fn(async () => { s.released = true; }) };
  return s;
}

describe("keepCallAwake", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setVisibility("visible");
  });

  it("holds a screen wake lock, re-acquires it after the page returns, and releases it", async () => {
    const sentinels: ReturnType<typeof fakeSentinel>[] = [];
    const request = vi.fn(async () => {
      const s = fakeSentinel();
      sentinels.push(s);
      return s;
    });
    vi.stubGlobal("navigator", { wakeLock: { request } });
    setVisibility("visible");

    const stop = keepCallAwake();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("screen");

    // The browser releases the lock when the page hides.
    sentinels[0].released = true;
    setVisibility("hidden");
    expect(request).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);

    stop();
    expect(sentinels[1].release).toHaveBeenCalled();
  });

  it("sets a play-and-record audio session for the call and restores it after", () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession });
    const stop = keepCallAwake();
    expect(audioSession.type).toBe("play-and-record");
    stop();
    expect(audioSession.type).toBe("auto");
  });

  it("is a no-op where neither API exists", () => {
    vi.stubGlobal("navigator", {});
    expect(() => keepCallAwake()()).not.toThrow();
  });
});

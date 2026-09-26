// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pausePlayingMedia, useEmbedPauseEpoch } from "./embedPause";

function media(tag: "audio" | "video", init: { paused?: boolean; muted?: boolean; srcObject?: unknown }) {
  const el = document.createElement(tag);
  Object.defineProperty(el, "paused", { value: init.paused ?? false });
  el.muted = init.muted ?? false;
  Object.defineProperty(el, "srcObject", { value: init.srcObject ?? null });
  el.pause = vi.fn();
  document.body.appendChild(el);
  return el;
}

describe("pausePlayingMedia", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("pauses audible media playing from a src", () => {
    const audio = media("audio", {});
    const video = media("video", {});
    pausePlayingMedia();
    expect(audio.pause).toHaveBeenCalled();
    expect(video.pause).toHaveBeenCalled();
  });

  it("leaves call tracks, muted loops and paused media alone", () => {
    const call = media("audio", { srcObject: {} });
    const gif = media("video", { muted: true });
    const idle = media("audio", { paused: true });
    pausePlayingMedia();
    expect(call.pause).not.toHaveBeenCalled();
    expect(gif.pause).not.toHaveBeenCalled();
    expect(idle.pause).not.toHaveBeenCalled();
  });

  it("advances the epoch embeds remount on", () => {
    const { result } = renderHook(() => useEmbedPauseEpoch());
    const before = result.current;
    act(() => pausePlayingMedia());
    expect(result.current).not.toBe(before);
  });
});

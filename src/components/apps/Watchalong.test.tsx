import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Watchalong } from "@/components/apps/Watchalong";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppContext, type AppContextType } from "@/contexts/AppContext";

import type { AppSync } from "@/hooks/useWebxdcApi";
import type { WatchSnapshot } from "@/lib/watchalong";

// The coordination plane, reduced to what the watchalong touches: a listener
// the test can deliver snapshots to, and a spy for what it broadcasts.
let deliver: (payload: unknown) => void = () => {};
const sendUpdate = vi.fn();
const api = {
  sendUpdate,
  setUpdateListener: (cb: (u: { payload: unknown }) => void) => {
    deliver = (payload) => cb({ payload });
    return Promise.resolve();
  },
};
vi.mock("@/hooks/useWebxdcApi", () => ({ useWebxdcApi: () => api }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "f".repeat(64) } }) }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useYouTubeTitle", () => ({ useYouTubeTitle: () => ({ data: undefined }) }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: () => null }));
const loadYouTubeApi = vi.fn(() => new Promise(() => {}));
vi.mock("@/lib/youtubeApi", () => ({ loadYouTubeApi: () => loadYouTubeApi(), YT_STATE: {} }));
vi.mock("@/lib/nativeYouTube", () => ({
  hasNativeYouTubePlayer: () => false,
  needsNativeYouTubePlayer: () => false,
  openNativeYouTube: vi.fn(),
  openYouTubeTargetPage: vi.fn(),
}));

const PROXY = "https://proxy.example/?url={href}";
const context = {
  config: {
    blossomServerMetadata: { servers: [] },
    mediaProxies: [PROXY],
  },
  updateConfig: vi.fn(),
} as unknown as AppContextType;

const CLIP = "https://cdn.example/films/clip.mp4";

function renderApp() {
  return render(
    <AppContext.Provider value={context}>
      <TooltipProvider>
        <Watchalong sync={{} as AppSync} />
      </TooltipProvider>
    </AppContext.Provider>,
  );
}

function snapshot(over: Partial<WatchSnapshot>): WatchSnapshot {
  return { queue: [{ id: "q1", url: CLIP }], current: 0, playing: false, time: 0, rev: 1, at: Date.now(), ...over };
}

const paused = new WeakMap<HTMLMediaElement, boolean>();
beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get() {
      return paused.get(this) ?? true;
    },
  });
  // Metadata is "loaded" so the player applies state straight away.
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
  HTMLMediaElement.prototype.load = vi.fn();
});

beforeEach(() => {
  sendUpdate.mockClear();
  loadYouTubeApi.mockClear();
  HTMLMediaElement.prototype.play = vi.fn(function (this: HTMLMediaElement) {
    paused.set(this, false);
    return Promise.resolve();
  });
  HTMLMediaElement.prototype.pause = vi.fn(function (this: HTMLMediaElement) {
    paused.set(this, true);
  });
});

describe("Watchalong", () => {
  it("adds a direct video link and plays it in a <video> loaded through the media proxy", async () => {
    const { container } = renderApp();
    fireEvent.change(screen.getByLabelText("YouTube or video link"), { target: { value: CLIP } });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    const sent = sendUpdate.mock.calls[0][0].payload as WatchSnapshot;
    expect(sent.queue).toEqual([expect.objectContaining({ url: CLIP })]);
    expect(sent.queue[0].videoId).toBeUndefined();
    expect(sent.playing).toBe(true);

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video!.getAttribute("src")).toBe(`https://proxy.example/?url=${encodeURIComponent(CLIP)}`);
    expect(loadYouTubeApi).not.toHaveBeenCalled();
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
  });

  it("keeps YouTube links on the embed", () => {
    const { container } = renderApp();
    fireEvent.change(screen.getByLabelText("YouTube or video link"), {
      target: { value: "https://youtu.be/dQw4w9WgXcQ" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    expect(container.querySelector("video")).toBeNull();
    expect(loadYouTubeApi).toHaveBeenCalledTimes(1);
  });

  it("explains a refused link", () => {
    renderApp();
    fireEvent.change(screen.getByLabelText("YouTube or video link"), {
      target: { value: "https://example.com/live.m3u8" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    expect(screen.getByText(/m3u8/)).toBeInTheDocument();
    expect(sendUpdate).not.toHaveBeenCalled();
  });

  it("applies a remote play/seek/rate snapshot to the <video>", () => {
    const { container } = renderApp();
    act(() => deliver(snapshot({ playing: true, time: 42, rate: 2, rev: 5 })));
    const video = container.querySelector("video")!;
    expect(video.playbackRate).toBe(2);
    expect(video.currentTime).toBeGreaterThanOrEqual(42);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

    act(() => deliver(snapshot({ playing: false, time: 10, rev: 6 })));
    expect(video.currentTime).toBe(10);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    // Applying a snapshot is not the viewer acting: nothing is re-broadcast.
    fireEvent(video, new Event("pause"));
    fireEvent(video, new Event("seeked"));
    expect(sendUpdate).not.toHaveBeenCalled();
  });

  it("broadcasts the viewer's own pause on the <video>", async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderApp();
      // Awaited so the apply's play() settles, as it has long before a click.
      await act(async () => deliver(snapshot({ playing: true, time: 0, rev: 5 })));
      act(() => vi.advanceTimersByTime(500)); // past the self-echo window
      const video = container.querySelector("video")!;
      paused.set(video, true);
      video.currentTime = 20;
      fireEvent(video, new Event("pause"));
      const sent = sendUpdate.mock.calls.at(-1)![0].payload as WatchSnapshot;
      expect(sent).toMatchObject({ playing: false, time: 20, rev: 6, queue: [{ id: "q1", url: CLIP }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not broadcast a pause when the browser blocked autoplay", async () => {
    vi.useFakeTimers();
    try {
      HTMLMediaElement.prototype.play = vi.fn(() =>
        Promise.reject(new DOMException("gesture needed", "NotAllowedError")),
      );
      const { container } = renderApp();
      await act(async () => deliver(snapshot({ playing: true, time: 30, rev: 5 })));
      expect(screen.getByRole("button", { name: /join playback/i })).toBeInTheDocument();
      // A slow seek from that apply lands after the self-echo window.
      act(() => vi.advanceTimersByTime(500));
      const video = container.querySelector("video")!;
      fireEvent(video, new Event("seeked"));
      fireEvent(video, new Event("pause"));
      expect(sendUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not crash on an entry this build has no player for", () => {
    renderApp();
    act(() => deliver(snapshot({ queue: [{ id: "q1", url: "javascript:alert(1)" }], playing: true, rev: 2 })));
    expect(screen.getByText(/can't be played in this version/)).toBeInTheDocument();
    expect(loadYouTubeApi).not.toHaveBeenCalled();
  });

  it("swaps a live YouTube embed for a direct video without losing the DOM", async () => {
    // The real API replaces the node it is handed with an iframe, and only
    // `destroy()` puts it back.
    const destroy = vi.fn();
    class Player {
      private iframe = document.createElement("iframe");
      constructor(private el: HTMLElement) {
        el.replaceWith(this.iframe);
      }
      destroy() {
        destroy();
        this.iframe.replaceWith(this.el);
      }
    }
    loadYouTubeApi.mockImplementationOnce(() => Promise.resolve({ Player }));
    const { container } = renderApp();
    await act(async () => deliver(snapshot({ queue: [{ id: "y1", videoId: "dQw4w9WgXcQ" }], rev: 2 })));
    expect(container.querySelector("iframe")).not.toBeNull();

    act(() => deliver(snapshot({ queue: [{ id: "y1", videoId: "dQw4w9WgXcQ" }, { id: "q1", url: CLIP }], current: 1, rev: 3 })));
    expect(container.querySelector("video")).not.toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(destroy).toHaveBeenCalled();
  });

  it("ignores a snapshot whose numbers are not finite", () => {
    const { container } = renderApp();
    act(() => deliver(snapshot({ playing: true, time: 5, rev: 2 })));
    const video = container.querySelector("video")!;
    // 1e400 is what JSON.parse turns into Infinity.
    act(() => deliver(JSON.parse('{"queue":[{"id":"q1","url":"' + CLIP + '"}],"current":0,"playing":true,"time":1e400,"rev":3,"at":0}')));
    act(() => deliver(JSON.parse('{"queue":[{"id":"q1","url":"' + CLIP + '"}],"current":0,"playing":true,"time":0,"rev":1e400,"at":0}')));
    expect(Number.isFinite(video.currentTime)).toBe(true);
    // A finite later revision still applies — the room isn't locked out.
    act(() => deliver(snapshot({ playing: false, time: 30, rev: 4 })));
    expect(video.currentTime).toBe(30);
  });
});

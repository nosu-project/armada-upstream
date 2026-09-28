import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Lightbox } from "@/components/chat/Lightbox";
import { VideoPlayer } from "@/components/chat/VideoPlayer";
import { AppContext, type AppContextType } from "@/contexts/AppContext";
import { ChatImageMenuContext, type ChatImageMenu } from "@/contexts/ChatImageMenuContext";

import type { LightboxItem } from "@/components/chat/Lightbox";
import type { ReactNode } from "react";

// "When viewing a video full screen the buttons in the bottom right corner do
// not work, neither the lines in the top right."

const context = {
  config: {
    appBlossomServers: [],
    blossomServerMetadata: { servers: [] },
    useAppBlossomServers: false,
    mediaProxies: [],
  },
  updateConfig: vi.fn(),
} as unknown as AppContextType;
const wrap = (children: ReactNode) => <AppContext.Provider value={context}>{children}</AppContext.Provider>;

const VIDEO: LightboxItem = { url: "https://example.com/clip.mp4", mime: "video/mp4", dim: "1920x1080" };
const IMAGE: LightboxItem = { url: "https://example.com/pic.png", mime: "image/png" };

// A minimal media stack: play()/pause() flip `paused` and fire the events the
// player listens to, so its React state follows the element.
beforeAll(() => {
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get() {
      return paused.get(this) ?? true;
    },
  });
  HTMLMediaElement.prototype.play = vi.fn(function (this: HTMLMediaElement) {
    paused.set(this, false);
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  HTMLMediaElement.prototype.pause = vi.fn(function (this: HTMLMediaElement) {
    paused.set(this, true);
    this.dispatchEvent(new Event("pause"));
  });
  HTMLMediaElement.prototype.load = vi.fn();
});

// jsdom ships no PointerEvent, so `pointerType` never reaches the handlers and
// every touch gesture reads as a non-touch one. Enough of it to carry the field.
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
    this.pointerId = init.pointerId ?? 1;
  }
}
window.PointerEvent = TestPointerEvent as unknown as typeof window.PointerEvent;

let fullscreen: Element | null = null;
function setFullscreen(el: Element | null) {
  fullscreen = el;
  document.dispatchEvent(new Event("fullscreenchange"));
}
Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });

afterEach(() => {
  fullscreen = null;
  vi.useRealTimers();
});

function renderLightbox(media: LightboxItem[]) {
  const onClose = vi.fn();
  render(wrap(<Lightbox media={media} currentIndex={0} onClose={onClose} onNext={vi.fn()} onPrev={vi.fn()} />));
  return { onClose };
}

async function startPlayback(video: HTMLVideoElement) {
  await act(async () => {
    await video.play();
  });
}

describe("video fullscreen controls", () => {
  it("Expand fullscreens the player container, so the app's control bar comes with it", async () => {
    renderLightbox([VIDEO]);
    const video = document.querySelector("video")!;
    video.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const container = document.querySelector<HTMLElement>("[data-video-player]")!;
    container.requestFullscreen = vi.fn().mockResolvedValue(undefined);

    // Start playback so the bottom bar mounts.
    await startPlayback(video);
    const expand = document.querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')!;
    expect(expand).not.toBeNull();
    fireEvent.click(expand);

    expect(container.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(video.requestFullscreen).not.toHaveBeenCalled();
    expect(container.contains(expand)).toBe(true);

    // The button follows the document's fullscreen state and exits it.
    act(() => setFullscreen(container));
    const exit = document.querySelector<HTMLButtonElement>('button[aria-label="Exit fullscreen"]')!;
    expect(exit).not.toBeNull();
    // Contained, not cropped, at full screen.
    expect(video.className).toContain("object-contain");
    expect(video.className).not.toContain("object-cover");

    document.exitFullscreen = vi.fn().mockResolvedValue(undefined);
    fireEvent.click(exit);
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);

    act(() => setFullscreen(null));
    expect(document.querySelector('button[aria-label="Fullscreen"]')).not.toBeNull();
  });

  it("falls back to the video's native fullscreen where the container can't go fullscreen (iPhone)", async () => {
    renderLightbox([VIDEO]);
    const video = document.querySelector("video")! as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    const container = document.querySelector<HTMLElement>("[data-video-player]")!;
    // No element fullscreen at all, as on iPhone Safari.
    Object.defineProperty(container, "requestFullscreen", { configurable: true, value: undefined });
    video.webkitEnterFullscreen = vi.fn();

    await startPlayback(video);
    fireEvent.click(document.querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')!);
    expect(video.webkitEnterFullscreen).toHaveBeenCalledTimes(1);
  });

  it("a tap on a native fullscreen control (retargeted to the <video> host) doesn't also toggle playback", async () => {
    renderLightbox([VIDEO]);
    const video = document.querySelector("video")!;
    await startPlayback(video);
    expect(video.paused).toBe(false);

    // A click inside the UA shadow root (native play/pause, exit-fullscreen,
    // overflow ⋮) reaches page script with target === the <video> host. jsdom
    // cannot attach a shadow root to <video>, so dispatch on the host directly.
    act(() => setFullscreen(video));
    await act(async () => {
      fireEvent.click(video);
    });
    expect(video.paused).toBe(false);

    // Inline, where only our chrome is shown, a tap still toggles.
    act(() => setFullscreen(null));
    await act(async () => {
      fireEvent.click(video);
    });
    expect(video.paused).toBe(true);
  });

  it("positions slots by strip width, so a rotation moves the neighbours with the viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 412 });
    renderLightbox([VIDEO, IMAGE]);

    const strip = document.querySelector("[data-lightbox-strip]")!;
    const [current, next] = Array.from(strip.children) as HTMLElement[];
    expect(current.style.transform).toBe("translateX(0%)");
    expect(next.style.transform).toBe("translateX(100%)");

    // Rotate to landscape — the usual way to watch a video "full screen".
    act(() => {
      (window as { innerWidth: number }).innerWidth = 915;
      window.dispatchEvent(new Event("resize"));
    });
    // Still one full strip-width to the right: offscreen, not overlapping the
    // right half of the current video.
    expect(next.style.transform).toBe("translateX(100%)");
  });

  it("a long-press on a lightbox video never opens the message's action sheet behind it", () => {
    vi.useFakeTimers();
    const menu: ChatImageMenu = { isTouch: true, openSheet: vi.fn(), stage: vi.fn() };
    // The lightbox is portaled, but context crosses portals: a lightbox opened
    // from a message still sits under that row's image menu.
    render(
      wrap(
        <ChatImageMenuContext.Provider value={menu}>
          <Lightbox media={[VIDEO]} currentIndex={0} onClose={vi.fn()} onNext={vi.fn()} onPrev={vi.fn()} />
        </ChatImageMenuContext.Provider>,
      ),
    );
    const video = document.querySelector("video")!;
    fireEvent.pointerDown(video, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.pointerUp(video, { pointerType: "touch", clientX: 10, clientY: 10 });
    expect(menu.openSheet).not.toHaveBeenCalled();
  });

  it("a long-press on an inline video opens the sheet, but not while it is fullscreen", () => {
    vi.useFakeTimers();
    const menu: ChatImageMenu = { isTouch: true, openSheet: vi.fn(), stage: vi.fn() };
    render(
      wrap(
        <ChatImageMenuContext.Provider value={menu}>
          <VideoPlayer src={VIDEO.url} mime={VIDEO.mime} dim={VIDEO.dim} />
        </ChatImageMenuContext.Provider>,
      ),
    );
    const video = document.querySelector("video")!;
    const longPress = () => {
      fireEvent.pointerDown(video, { pointerType: "touch", clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      fireEvent.pointerUp(video, { pointerType: "touch", clientX: 10, clientY: 10 });
    };

    act(() => setFullscreen(document.querySelector("[data-video-player]")));
    longPress();
    expect(menu.openSheet).not.toHaveBeenCalled();

    act(() => setFullscreen(null));
    longPress();
    expect(menu.openSheet).toHaveBeenCalledTimes(1);
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Lightbox } from "@/components/chat/Lightbox";
import { AppContext, type AppContextType } from "@/contexts/AppContext";

import type { LightboxItem } from "@/components/chat/Lightbox";
import type { ReactNode } from "react";

// The media hooks read the Blossom mirror config and the media policy off the
// app context object itself; none of these URLs have a mirror, and no proxy is
// set so the resolver stays on the plain URL (routing has its own suites).
const context = {
  config: {
    appBlossomServers: [],
    blossomServerMetadata: { servers: [] },
    useAppBlossomServers: false,
    mediaProxy: "",
  },
  updateConfig: vi.fn(),
} as unknown as AppContextType;
const wrap = (children: ReactNode) => <AppContext.Provider value={context}>{children}</AppContext.Provider>;

const VIDEO: LightboxItem = {
  url: "https://example.com/clip.mp4",
  mime: "video/mp4",
  poster: "https://example.com/clip.jpg",
};
const IMAGE: LightboxItem = { url: "https://example.com/pic.png", mime: "image/png" };

// jsdom has no media stack, so pause() is "not implemented" — stub it out and
// use the stub to observe the slot's own pause-when-inactive behavior. load()
// is stubbed for the same reason: the player's off-screen thumbnail grab calls
// it on teardown, which otherwise logs an unimplemented-API error.
const pause = vi.fn();
beforeAll(() => {
  HTMLMediaElement.prototype.pause = pause;
  HTMLMediaElement.prototype.load = vi.fn();
  // The player calls play() programmatically on the tap-to-start click.
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});
beforeEach(() => pause.mockClear());

function renderLightbox(media: LightboxItem[], currentIndex = 0) {
  const onClose = vi.fn();
  const view = render(
    wrap(
      <Lightbox
        media={media}
        currentIndex={currentIndex}
        onClose={onClose}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />,
    ),
  );
  return { onClose, view };
}

describe("Lightbox", () => {
  it("gives a video item a player rather than an image slot", () => {
    renderLightbox([VIDEO]);

    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("src", VIDEO.url);
    // The player may paint a poster <img> overlay (its own thumbnail), but the
    // clip itself is never rendered as a zoomable image slot.
    expect(document.querySelector("[data-video-player]")).not.toBeNull();
    const imgs = Array.from(document.querySelectorAll("img"));
    expect(imgs.some((i) => i.getAttribute("src") === VIDEO.url)).toBe(false);
  });

  it("loops the video, so a short clip keeps playing", () => {
    renderLightbox([VIDEO]);

    expect(document.querySelector("video")).toHaveProperty("loop", true);
  });

  it("still renders an image item as a zoomable image", () => {
    renderLightbox([IMAGE]);

    expect(document.querySelector("img")).toHaveAttribute("src", IMAGE.url);
    expect(document.querySelector("video")).toBeNull();
  });

  it("names the kind of media in the download button", () => {
    const { view } = renderLightbox([VIDEO]);
    expect(screen.getByLabelText("Download video")).toBeInTheDocument();

    view.unmount();
    renderLightbox([IMAGE]);
    expect(screen.getByLabelText("Download image")).toBeInTheDocument();
  });

  it("does not close when the video is clicked — the click is play/pause", () => {
    const { onClose } = renderLightbox([VIDEO]);

    fireEvent.click(document.querySelector("video")!);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("still closes on a backdrop click", () => {
    const { onClose } = renderLightbox([VIDEO]);

    fireEvent.click(document.querySelector("[data-lightbox-content]")!);

    expect(onClose).toHaveBeenCalled();
  });

  it("leaves the arrow keys to a focused video so they seek instead of paging", () => {
    const media = [VIDEO, IMAGE];
    const onNext = vi.fn();
    render(
      wrap(
        <Lightbox
          media={media}
          currentIndex={0}
          onClose={vi.fn()}
          onNext={onNext}
          onPrev={vi.fn()}
        />,
      ),
    );

    fireEvent.keyDown(document.querySelector("video")!, { key: "ArrowRight" });
    expect(onNext).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNext).toHaveBeenCalled();
  });

  it("pauses a video slot once it is no longer the current one", () => {
    const second: LightboxItem = { url: "https://example.com/other.mp4", mime: "video/mp4" };
    const { view } = renderLightbox([VIDEO, second], 0);
    pause.mockClear();

    view.rerender(
      wrap(
        <Lightbox
          media={[VIDEO, second]}
          currentIndex={1}
          onClose={vi.fn()}
          onNext={vi.fn()}
          onPrev={vi.fn()}
        />,
      ),
    );

    expect(pause).toHaveBeenCalled();
  });
});

import { act, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppContext, type AppContextType } from "@/contexts/AppContext";

import { AudioMessage } from "./AudioMessage";

/**
 * An auto-embedded mp3 that fails its first source must actually RELOAD the
 * next candidate. `AudioMessage` renders its source as a `<source>` child, and
 * per the HTML spec changing a `<source>`'s `src` after insertion does nothing
 * on its own — the media element only re-runs resource selection on `load()`
 * or when it is replaced, which is what the player's `key` does.
 */
function wrapperWith(mediaProxies: string[]) {
  const context = {
    config: {
      appBlossomServers: [],
      blossomServerMetadata: { servers: [], updatedAt: 0 },
      useAppBlossomServers: false,
      mediaProxies,
    },
    updateConfig: vi.fn(),
  } as unknown as AppContextType;
  return ({ children }: { children: React.ReactNode }) =>
    createElement(AppContext.Provider, { value: context }, children);
}

const URL_MP3 = "https://files.example/song.mp3";

let loadSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // jsdom does not implement media loading; record calls instead.
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => loadSpy.mockRestore());

function sourceSrc(container: HTMLElement): string | null {
  return container.querySelector("audio source")?.getAttribute("src") ?? null;
}

describe("AudioMessage — cross-candidate fallback", () => {
  it("an error on the first proxy's <source> makes the element load the next proxy", () => {
    const wrapper = wrapperWith(["https://p1.example/?url=", "https://p2.example/?url="]);
    const { container } = render(<AudioMessage src={URL_MP3} mime="audio/mpeg" />, { wrapper });

    const audioBefore = container.querySelector("audio")!;
    const firstSrc = sourceSrc(container);
    expect(firstSrc).toMatch(/^https:\/\/p[12]\.example\//);

    // In a browser a failed <source> fires `error` on the <source>, not on the
    // <audio>; React re-dispatches it through the tree to <audio onError>.
    fireEvent.error(container.querySelector("audio source")!);

    const audioAfter = container.querySelector("audio")!;
    const secondSrc = sourceSrc(container);
    // The walk DID advance (hook-level fallback works)...
    expect(secondSrc).not.toBe(firstSrc);
    expect(secondSrc).toMatch(/^https:\/\/p[12]\.example\//);

    // ...and the browser only picks up the new <source> if the element is
    // replaced or load() is called on it; otherwise it would stay on the
    // failed first candidate, silent, with no "unavailable" card.
    const reloaded = audioAfter !== audioBefore || loadSpy.mock.calls.length > 0;
    expect(reloaded).toBe(true);
  });

  it("an imeta `fallback` URL is actually loaded after the primary fails (no proxy)", () => {
    const wrapper = wrapperWith([]);
    const { container } = render(
      <AudioMessage src={URL_MP3} mime="audio/mpeg" fallbacks={["https://mirror.example/song.mp3"]} />,
      { wrapper },
    );
    const audioBefore = container.querySelector("audio")!;
    expect(sourceSrc(container)).toBe(URL_MP3);

    fireEvent.error(container.querySelector("audio source")!);

    expect(sourceSrc(container)).toBe("https://mirror.example/song.mp3");
    const reloaded = container.querySelector("audio") !== audioBefore || loadSpy.mock.calls.length > 0;
    expect(reloaded).toBe(true);
  });

  it("a play() rejected as NotSupportedError walks to the next candidate and plays it", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(Object.assign(new Error("unsupported"), { name: "NotSupportedError" }))
      .mockResolvedValue(undefined);
    try {
      const wrapper = wrapperWith([]);
      const { container, getByRole } = render(
        <AudioMessage src={URL_MP3} mime="audio/mpeg" fallbacks={["https://mirror.example/song.mp3"]} />,
        { wrapper },
      );
      const audioBefore = container.querySelector("audio")!;

      await act(async () => {
        fireEvent.click(getByRole("button", { name: "Play" }));
      });

      expect(sourceSrc(container)).toBe("https://mirror.example/song.mp3");
      expect(container.querySelector("audio")).not.toBe(audioBefore);
      // The viewer asked to hear it: the replacement is started too.
      expect(play).toHaveBeenCalledTimes(2);
    } finally {
      play.mockRestore();
    }
  });

  it("a late play() rejection from a candidate already walked past does not skip the next one", async () => {
    let rejectFirst!: (err: unknown) => void;
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
      .mockResolvedValue(undefined);
    try {
      const wrapper = wrapperWith([]);
      const { container, getByRole } = render(
        <AudioMessage
          src={URL_MP3}
          mime="audio/mpeg"
          fallbacks={["https://mirror.example/song.mp3", "https://mirror2.example/song.mp3"]}
        />,
        { wrapper },
      );
      fireEvent.click(getByRole("button", { name: "Play" }));
      // The <source> fails first and walks on; then its play() rejects too.
      fireEvent.error(container.querySelector("audio source")!);
      expect(sourceSrc(container)).toBe("https://mirror.example/song.mp3");
      await act(async () => {
        rejectFirst(Object.assign(new Error("unsupported"), { name: "NotSupportedError" }));
      });
      expect(sourceSrc(container)).toBe("https://mirror.example/song.mp3");
    } finally {
      play.mockRestore();
    }
  });

  it("a play() rejected as NotAllowedError (no gesture) stays on the current candidate", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    try {
      const wrapper = wrapperWith([]);
      const { container, getByRole } = render(
        <AudioMessage src={URL_MP3} mime="audio/mpeg" fallbacks={["https://mirror.example/song.mp3"]} />,
        { wrapper },
      );
      const audioBefore = container.querySelector("audio")!;

      await act(async () => {
        fireEvent.click(getByRole("button", { name: "Play" }));
      });

      expect(sourceSrc(container)).toBe(URL_MP3);
      expect(container.querySelector("audio")).toBe(audioBefore);
    } finally {
      play.mockRestore();
    }
  });

  it("a single-candidate direct URL (the default, proxy off) goes straight to the fallback card on error", () => {
    const wrapper = wrapperWith([]);
    const { container, getByText } = render(<AudioMessage src={URL_MP3} mime="audio/mpeg" />, { wrapper });
    fireEvent.error(container.querySelector("audio source")!);
    expect(container.querySelector("audio")).toBeNull();
    // MediaFallback: link + retry, not a silent dead player.
    expect(getByText(/audio/i)).toBeTruthy();
  });
});

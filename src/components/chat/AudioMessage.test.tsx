import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { clearAudioMetadata, primeAudioMetadata, primeAudioWaveform } from "@/hooks/useAudioMetadata";

import { AudioMessage } from "./AudioMessage";

afterEach(() => clearAudioMetadata());

describe("AudioMessage", () => {
  it("presents a music file by the tags read from the file", () => {
    const src = "https://blossom.example/intro.mp3";
    primeAudioMetadata(src, { title: "Intro", artist: "Limp Bizkit", album: "Significant Other", year: "1999" });
    render(<AudioMessage src={src} mime="audio/mpeg" duration="37" />);
    expect(screen.getByText("Intro")).toBeInTheDocument();
    expect(screen.getByText("Limp Bizkit · Significant Other · 1999")).toBeInTheDocument();
    expect(screen.getByText("0:37")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("keeps a file with no tags to the bare player", () => {
    const src = "https://blossom.example/voice.webm";
    primeAudioMetadata(src, {});
    const { container } = render(<AudioMessage src={src} mime="audio/webm" waveform="10 50 90" />);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(container.querySelector("p")).toBeNull();
  });

  it("draws the waveform computed from the file, and a flat bar where there is none", () => {
    const heights = (container: HTMLElement) =>
      [...container.querySelectorAll<HTMLElement>('[role="slider"] > div')].map((bar) => bar.style.height);

    const shaped = "https://blossom.example/shaped.mp3";
    primeAudioWaveform(shaped, [0, 100]);
    const { container, unmount } = render(<AudioMessage src={shaped} mime="audio/mpeg" />);
    expect(heights(container)).toEqual(["4px", "28px"]);
    unmount();

    const unknown = "https://blossom.example/unknown.mp3";
    primeAudioWaveform(unknown, undefined);
    const flat = render(<AudioMessage src={unknown} mime="audio/mpeg" />);
    expect(new Set(heights(flat.container)).size).toBe(1);
  });
});

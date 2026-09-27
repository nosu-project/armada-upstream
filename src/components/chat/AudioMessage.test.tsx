import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { clearAudioMetadata, primeAudioMetadata } from "@/hooks/useAudioMetadata";

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
});

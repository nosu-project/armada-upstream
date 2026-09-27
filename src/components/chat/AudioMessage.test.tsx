import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AudioMessage } from "./AudioMessage";

describe("AudioMessage", () => {
  it("presents a tagged music file as a track", () => {
    render(
      <AudioMessage
        src="https://blossom.example/intro.mp3"
        mime="audio/mpeg"
        duration="37"
        title="Intro"
        artist="Limp Bizkit"
        album="Significant Other"
        year="1999"
      />,
    );
    expect(screen.getByText("Intro")).toBeInTheDocument();
    expect(screen.getByText("Limp Bizkit · Significant Other · 1999")).toBeInTheDocument();
    expect(screen.getByText("0:37")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("keeps a voice message to the bare player", () => {
    const { container } = render(
      <AudioMessage src="https://blossom.example/voice.webm" mime="audio/webm" waveform="10 50 90" />,
    );
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(container.querySelector("p")).toBeNull();
  });
});

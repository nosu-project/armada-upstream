import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: "web",
  pluginAvailable: false,
  open: vi.fn(async (_options: { videoId: string }): Promise<void> => {}),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => native.platform,
    isPluginAvailable: () => native.pluginAvailable,
  },
  registerPlugin: () => ({ open: native.open }),
}));

import { YouTubeEmbed } from "@/components/chat/LinkEmbed";

beforeEach(() => {
  native.platform = "web";
  native.pluginAvailable = false;
  native.open.mockClear().mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("YouTubeEmbed", () => {
  it("does not contact YouTube until the viewer clicks play", () => {
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    expect(screen.queryByTitle("YouTube video")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play video" })).toBeInTheDocument();
  });

  it("lets the browser identify the deployment that actually hosts Armada", () => {
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    const iframe = screen.getByTitle<HTMLIFrameElement>("YouTube video");
    expect(iframe).toHaveAttribute("referrerpolicy", "strict-origin-when-cross-origin");

    const playerUrl = new URL(iframe.src);
    expect(playerUrl.origin).toBe("https://www.youtube-nocookie.com");
    expect(playerUrl.searchParams.get("origin")).toBeNull();
    expect(iframe.outerHTML).not.toContain("buzz.armada.app");
  });

  it("keeps Capacitor Android on the HTTPS-referrer iframe path", () => {
    native.platform = "android";
    native.pluginAvailable = true;
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    expect(screen.getByTitle("YouTube video")).toHaveAttribute(
      "referrerpolicy",
      "strict-origin-when-cross-origin",
    );
    expect(native.open).not.toHaveBeenCalled();
  });

  it("uses the referrer-bearing native player on Capacitor iOS", async () => {
    native.platform = "ios";
    native.pluginAvailable = true;
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    await waitFor(() => expect(native.open).toHaveBeenCalledWith({ videoId: "dQw4w9WgXcQ" }));
    expect(screen.queryByTitle("YouTube video")).not.toBeInTheDocument();
  });

  it("offers a user-activated watch-page fallback when native presentation fails", async () => {
    native.platform = "ios";
    native.pluginAvailable = true;
    native.open.mockRejectedValue(new Error("presentation failed"));
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    const fallback = await screen.findByRole("button", { name: "Open video on YouTube" });
    expect(openWindow).not.toHaveBeenCalled();
    fireEvent.click(fallback);
    expect(openWindow).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("opens the watch page instead of a broken iframe on older iOS builds", () => {
    native.platform = "ios";
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    expect(openWindow).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "_blank",
      "noopener,noreferrer",
    );
    expect(screen.queryByTitle("YouTube video")).not.toBeInTheDocument();
  });
});

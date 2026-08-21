import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScreenShareDiagnosticsDialog } from "@/components/chat/ScreenShareDiagnosticsDialog";

describe("ScreenShareDiagnosticsDialog", () => {
  it("renders in Armada's chrome dialog shell", () => {
    render(<ScreenShareDiagnosticsDialog open onOpenChange={vi.fn()} />);

    // ChromeDialogContent is the app's single dialog idiom; the bare shadcn
    // card it replaces has no cut corners and no chrome vessel.
    expect(document.querySelector(".chrome-dialog")).not.toBeNull();
    expect(document.querySelector(".chrome-dialog-title")?.textContent).toBe("stream details");
  });

  it("renders its overlay and dialog inside a supplied portal container", () => {
    const portalContainer = document.createElement("div");
    document.body.appendChild(portalContainer);
    const { unmount } = render(
      <ScreenShareDiagnosticsDialog
        open
        portalContainer={portalContainer}
        onOpenChange={vi.fn()}
      />,
    );

    expect(portalContainer.querySelector("[data-radix-dialog-overlay]")).not.toBeNull();
    expect(portalContainer).toContainElement(screen.getByRole("dialog"));

    unmount();
    portalContainer.remove();
  });

  it("shows live custom HEVC pipeline details on demand", () => {
    render(
      <ScreenShareDiagnosticsDialog
        open
        encrypted
        participantName="you"
        nativeHevcStatus={{
          state: "published",
          active: true,
          backend: "FFmpeg hevc_vaapi",
          encoder: "hevc_vaapi",
          device: "/dev/dri/renderD128",
          width: 2560,
          height: 1440,
          frameRate: 60,
          bitrate: 25_000_000,
          framesReceived: 1905,
          framesDropped: 694,
          inputFrameRate: 44.2,
          encodedBitrate: 18_330_000,
          pipelineStage: "Streaming",
        }}
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText("H.265 / HEVC Main")).toBeInTheDocument();
    expect(screen.getByText("2560×1440 @ 60 FPS")).toBeInTheDocument();
    expect(screen.getByText("FFmpeg hevc_vaapi")).toBeInTheDocument();
    expect(screen.getByText("/dev/dri/renderD128")).toBeInTheDocument();
    expect(screen.getByText("1905 / 694")).toBeInTheDocument();
    expect(screen.getByText("44.2 FPS")).toBeInTheDocument();
    expect(screen.getByText("18.33 Mbps")).toBeInTheDocument();
    expect(screen.getByText("published")).toBeInTheDocument();
  });
});

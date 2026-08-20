import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenShareQualityDialog } from "@/components/chat/ScreenShareQualityDialog";
import { SCREEN_SHARE_QUALITY_KEY } from "@/lib/screenShareQuality";

afterEach(() => {
  localStorage.removeItem(SCREEN_SHARE_QUALITY_KEY);
  vi.unstubAllGlobals();
});

describe("ScreenShareQualityDialog", () => {
  it("renders in Armada's chrome dialog shell", () => {
    render(
      <ScreenShareQualityDialog
        open
        active={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    // ChromeDialogContent is the app's single dialog idiom; the bare shadcn
    // card it replaces has no cut corners and no chrome vessel.
    expect(document.querySelector(".chrome-dialog")).not.toBeNull();
    expect(document.querySelector(".chrome-dialog-title")?.textContent).toBe("screen share quality");
  });

  it("keeps its dialog and select list inside a supplied portal container", () => {
    const portalContainer = document.createElement("div");
    document.body.appendChild(portalContainer);
    const { unmount } = render(
      <ScreenShareQualityDialog
        open
        portalContainer={portalContainer}
        active={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(portalContainer).toContainElement(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("combobox", { name: "Resolution" }));
    expect(portalContainer).toContainElement(screen.getByRole("listbox"));

    unmount();
    portalContainer.remove();
  });

  it("submits a custom bitrate for an active share", () => {
    const onConfirm = vi.fn();
    render(
      <ScreenShareQualityDialog
        open
        active
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByLabelText(/maximum bitrate/i), {
      target: { value: "8.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onConfirm).toHaveBeenCalledWith({
      resolution: "1080p",
      frameRate: 30,
      codec: "vp8",
      delivery: "full",
      maxBitrate: 8_500_000,
    });
  });

  it("resets to the recommended 1080p30 at 5 Mbps default", () => {
    localStorage.setItem(
      SCREEN_SHARE_QUALITY_KEY,
      JSON.stringify({
        resolution: "2160p",
        frameRate: 60,
        codec: "av1",
        delivery: "adaptive",
        maxBitrate: 20_000_000,
      }),
    );
    const onConfirm = vi.fn();
    render(
      <ScreenShareQualityDialog
        open
        active={false}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reset defaults/i }));
    fireEvent.click(screen.getByRole("button", { name: /share screen/i }));

    expect(onConfirm).toHaveBeenCalledWith({
      resolution: "1080p",
      frameRate: 30,
      codec: "vp8",
      delivery: "full",
      maxBitrate: 5_000_000,
    });
  });

  it("does not submit a persisted HEVC choice when this sender lacks H.265", () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }],
        headerExtensions: [],
      }),
    });
    localStorage.setItem(
      SCREEN_SHARE_QUALITY_KEY,
      JSON.stringify({
        resolution: "1440p",
        frameRate: 60,
        codec: "h265",
        delivery: "full",
        maxBitrate: 10_000_000,
      }),
    );
    const onConfirm = vi.fn();
    render(
      <ScreenShareQualityDialog
        open
        active={false}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /share screen/i }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ codec: "vp8" }));
  });

  it("keeps the user's edits when the H.265 capability probe resolves late", async () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }],
        headerExtensions: [],
      }),
    });
    const onConfirm = vi.fn();
    // The desktop shell probes the encoder asynchronously, so this flag flips
    // whenever that resolves — routinely while the dialog is already open.
    const { rerender } = render(
      <ScreenShareQualityDialog
        open
        active={false}
        customHevcAvailable={false}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByLabelText(/maximum bitrate/i), {
      target: { value: "12" },
    });
    rerender(
      <ScreenShareQualityDialog
        open
        active={false}
        customHevcAvailable
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /share screen/i }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ maxBitrate: 12_000_000 }),
    );
  });

  it("does not offer AV1 for an end-to-end encrypted Concord share", () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [
          { mimeType: "video/VP8", clockRate: 90_000 },
          { mimeType: "video/AV1", clockRate: 90_000 },
        ],
        headerExtensions: [],
      }),
    });
    localStorage.setItem(
      SCREEN_SHARE_QUALITY_KEY,
      JSON.stringify({
        resolution: "1440p",
        frameRate: 60,
        codec: "av1",
        delivery: "full",
        maxBitrate: 10_000_000,
      }),
    );
    const onConfirm = vi.fn();
    render(
      <ScreenShareQualityDialog
        open
        active={false}
        endToEndEncrypted
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /share screen/i }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ codec: "vp8" }));
  });

  it("keeps independently probed custom HEVC and forces a single full layer", () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }],
        headerExtensions: [],
      }),
    });
    localStorage.setItem(
      SCREEN_SHARE_QUALITY_KEY,
      JSON.stringify({
        resolution: "1440p",
        frameRate: 60,
        codec: "h265",
        delivery: "adaptive",
        maxBitrate: 25_000_000,
      }),
    );
    const onConfirm = vi.fn();
    render(
      <ScreenShareQualityDialog
        open
        active={false}
        endToEndEncrypted
        customHevcAvailable
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /share screen/i }));

    expect(onConfirm).toHaveBeenCalledWith({
      resolution: "1440p",
      frameRate: 60,
      codec: "h265",
      delivery: "full",
      maxBitrate: 25_000_000,
    });
  });
});

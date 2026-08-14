import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SCREEN_SHARE_QUALITY,
  MAX_SCREEN_SHARE_BITRATE,
  SCREEN_SHARE_QUALITY_KEY,
  getScreenShareQuality,
  normalizeScreenShareQuality,
  rememberScreenShareQuality,
  screenShareCaptureOptions,
  screenSharePublishOptions,
  screenShareVideoConstraints,
  supportedScreenShareCodecs,
} from "@/lib/screenShareQuality";

afterEach(() => {
  localStorage.removeItem(SCREEN_SHARE_QUALITY_KEY);
  vi.unstubAllGlobals();
});

describe("screen-share quality policy", () => {
  it("maps resolution, FPS, and bitrate into capture and publish settings", () => {
    const quality = {
      resolution: "1440p" as const,
      frameRate: 60 as const,
      codec: "vp9" as const,
      delivery: "adaptive" as const,
      maxBitrate: 10_000_000,
    };

    expect(screenShareCaptureOptions(quality)).toEqual({
      audio: true,
      contentHint: "detail",
      resolution: { width: 2560, height: 1440, frameRate: 60 },
    });
    expect(screenShareVideoConstraints(quality)).toEqual({
      width: { ideal: 2560, max: 2560 },
      height: { ideal: 1440, max: 1440 },
      frameRate: { ideal: 60, max: 60 },
    });

    const publish = screenSharePublishOptions(quality);
    expect(publish.videoCodec).toBe("vp9");
    expect(publish.simulcast).toBe(true);
    expect(publish.screenShareEncoding).toEqual({
      maxBitrate: 10_000_000,
      maxFramerate: 60,
      priority: "medium",
    });
    expect(publish.screenShareSimulcastLayers).toHaveLength(1);
    expect(publish.screenShareSimulcastLayers?.[0]).toMatchObject({
      width: 1280,
      height: 720,
      encoding: { maxBitrate: 2_500_000, maxFramerate: 60 },
    });
  });

  it("publishes only the full-resolution encoding in full-quality mode", () => {
    const publish = screenSharePublishOptions(DEFAULT_SCREEN_SHARE_QUALITY);

    expect(publish.videoCodec).toBe("vp8");
    expect(publish.simulcast).toBe(false);
    expect(publish.screenShareSimulcastLayers).toEqual([]);
  });

  it("bounds invalid persisted settings", () => {
    expect(
      normalizeScreenShareQuality({
        resolution: "8k",
        frameRate: 144,
        maxBitrate: 100_000_000,
      }),
    ).toEqual({
      ...DEFAULT_SCREEN_SHARE_QUALITY,
      maxBitrate: MAX_SCREEN_SHARE_BITRATE,
    });
  });

  it("remembers a validated device-local selection", () => {
    const selected = {
      resolution: "2160p" as const,
      frameRate: 30 as const,
      codec: "av1" as const,
      delivery: "adaptive" as const,
      maxBitrate: 15_000_000,
    };

    expect(rememberScreenShareQuality(selected)).toEqual(selected);
    expect(getScreenShareQuality()).toEqual(selected);
  });

  it("falls back when stored JSON is unreadable", () => {
    localStorage.setItem(SCREEN_SHARE_QUALITY_KEY, "not-json");
    expect(getScreenShareQuality()).toEqual(DEFAULT_SCREEN_SHARE_QUALITY);
  });

  it("offers H.265 only when the browser advertises an HEVC sender", () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [
          { mimeType: "video/VP8", clockRate: 90_000 },
          { mimeType: "video/H265", clockRate: 90_000 },
        ],
      }),
    });
    expect(supportedScreenShareCodecs()).toEqual(new Set(["vp8", "h265"]));
  });

  it("removes AV1 from end-to-end encrypted calls even when Chromium advertises it", () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [
          { mimeType: "video/VP8", clockRate: 90_000 },
          { mimeType: "video/AV1", clockRate: 90_000 },
        ],
      }),
    });

    expect(supportedScreenShareCodecs({ endToEndEncrypted: true }))
      .toEqual(new Set(["vp8"]));
  });

  it("uses a conservative fallback when Chromium cannot report capabilities", () => {
    vi.stubGlobal("RTCRtpSender", {});

    expect(supportedScreenShareCodecs()).toEqual(new Set(["vp8", "h264"]));
    expect(supportedScreenShareCodecs({ customHevc: true }))
      .toEqual(new Set(["vp8", "h264", "h265"]));
  });

  it("offers independently probed custom H.265 even when WebRTC does not", () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }],
      }),
    });

    expect(supportedScreenShareCodecs({ customHevc: true }))
      .toEqual(new Set(["vp8", "h265"]));
  });
});

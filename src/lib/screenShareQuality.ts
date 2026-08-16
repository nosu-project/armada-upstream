import {
  VideoPreset,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCodec,
} from "livekit-client";

export const SCREEN_SHARE_QUALITY_KEY = "armada:voice:screenShareQuality";

export const SCREEN_SHARE_RESOLUTIONS = [
  { id: "720p", label: "720p", width: 1280, height: 720 },
  { id: "1080p", label: "1080p", width: 1920, height: 1080 },
  { id: "1440p", label: "1440p", width: 2560, height: 1440 },
  { id: "2160p", label: "4K", width: 3840, height: 2160 },
] as const;

export const SCREEN_SHARE_FRAME_RATES = [5, 15, 30, 60] as const;
export const SCREEN_SHARE_CODECS = [
  { id: "vp8", label: "VP8", description: "Best compatibility" },
  { id: "h264", label: "H.264", description: "Often hardware accelerated" },
  { id: "h265", label: "H.265 / HEVC", description: "Hardware and viewer support required" },
  { id: "vp9", label: "VP9", description: "Better detail at lower bitrates" },
  { id: "av1", label: "AV1", description: "Best compression, highest encoder cost" },
] as const satisfies ReadonlyArray<{
  id: VideoCodec;
  label: string;
  description: string;
}>;
export const SCREEN_SHARE_DELIVERY_MODES = [
  {
    id: "full",
    label: "Full quality",
    description: "Send one full-resolution stream to every viewer",
  },
  {
    id: "adaptive",
    label: "Adaptive",
    description: "Also send a half-resolution layer for smaller views",
  },
] as const;
export const MIN_SCREEN_SHARE_BITRATE = 250_000;
export const MAX_SCREEN_SHARE_BITRATE = 25_000_000;
export const SCREEN_SHARE_BITRATE_STEP = 250_000;

export type ScreenShareResolutionId = (typeof SCREEN_SHARE_RESOLUTIONS)[number]["id"];
export type ScreenShareFrameRate = (typeof SCREEN_SHARE_FRAME_RATES)[number];
export type ScreenShareCodec = (typeof SCREEN_SHARE_CODECS)[number]["id"];
export type ScreenShareDeliveryMode = (typeof SCREEN_SHARE_DELIVERY_MODES)[number]["id"];

export interface ScreenShareQuality {
  resolution: ScreenShareResolutionId;
  frameRate: ScreenShareFrameRate;
  codec: ScreenShareCodec;
  delivery: ScreenShareDeliveryMode;
  /** Maximum bitrate for the full-resolution layer, in bits per second. */
  maxBitrate: number;
}

export const DEFAULT_SCREEN_SHARE_QUALITY: ScreenShareQuality = {
  resolution: "1080p",
  frameRate: 30,
  codec: "vp8",
  delivery: "full",
  maxBitrate: 5_000_000,
};

function resolutionOption(id: ScreenShareResolutionId) {
  return SCREEN_SHARE_RESOLUTIONS.find((option) => option.id === id)!;
}

function isResolution(value: unknown): value is ScreenShareResolutionId {
  return SCREEN_SHARE_RESOLUTIONS.some((option) => option.id === value);
}

function isFrameRate(value: unknown): value is ScreenShareFrameRate {
  return SCREEN_SHARE_FRAME_RATES.some((frameRate) => frameRate === value);
}

function isCodec(value: unknown): value is ScreenShareCodec {
  return SCREEN_SHARE_CODECS.some((codec) => codec.id === value);
}

function isDeliveryMode(value: unknown): value is ScreenShareDeliveryMode {
  return SCREEN_SHARE_DELIVERY_MODES.some((mode) => mode.id === value);
}

function normalizeBitrate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SCREEN_SHARE_QUALITY.maxBitrate;
  }
  const clamped = Math.min(MAX_SCREEN_SHARE_BITRATE, Math.max(MIN_SCREEN_SHARE_BITRATE, value));
  return Math.round(clamped / SCREEN_SHARE_BITRATE_STEP) * SCREEN_SHARE_BITRATE_STEP;
}

/** Validate persisted or user-entered quality values and apply safe bounds. */
export function normalizeScreenShareQuality(value: unknown): ScreenShareQuality {
  if (!value || typeof value !== "object") return { ...DEFAULT_SCREEN_SHARE_QUALITY };
  const candidate = value as Partial<ScreenShareQuality>;
  return {
    resolution: isResolution(candidate.resolution)
      ? candidate.resolution
      : DEFAULT_SCREEN_SHARE_QUALITY.resolution,
    frameRate: isFrameRate(candidate.frameRate)
      ? candidate.frameRate
      : DEFAULT_SCREEN_SHARE_QUALITY.frameRate,
    codec: isCodec(candidate.codec) ? candidate.codec : DEFAULT_SCREEN_SHARE_QUALITY.codec,
    delivery: isDeliveryMode(candidate.delivery)
      ? candidate.delivery
      : DEFAULT_SCREEN_SHARE_QUALITY.delivery,
    maxBitrate: normalizeBitrate(candidate.maxBitrate),
  };
}

/** Codecs the current browser and call security profile can actually publish. */
export function supportedScreenShareCodecs({
  endToEndEncrypted = false,
  customHevc = false,
}: { endToEndEncrypted?: boolean; customHevc?: boolean } = {}): ReadonlySet<ScreenShareCodec> {
  const sender = globalThis.RTCRtpSender;
  if (!sender?.getCapabilities) {
    // A missing capabilities API is not evidence that every optional codec
    // exists. VP8 + H.264 are WebRTC's conservative interoperability floor;
    // the custom Linux publisher is independently probed by the desktop shell.
    const fallback = new Set<ScreenShareCodec>(["vp8", "h264"]);
    if (customHevc) fallback.add("h265");
    return fallback;
  }
  const mimeTypes = new Set(
    (sender.getCapabilities("video")?.codecs ?? []).map((codec) => codec.mimeType.toLowerCase()),
  );
  const supported = new Set<ScreenShareCodec>(
    SCREEN_SHARE_CODECS
      .filter(
        (codec) =>
          mimeTypes.has(`video/${codec.id}`) &&
          !(endToEndEncrypted && codec.id === "av1"),
      )
      .map((codec) => codec.id),
  );
  if (customHevc) supported.add("h265");
  return supported;
}

/**
 * Explain a codec that `supportedScreenShareCodecs` did not offer.
 *
 * There is deliberately no `customHevc` option: that flag only ever *adds*
 * h265 to the supported set, so a caller can only reach here with the custom
 * publisher absent — a branch keyed on it would assert the opposite of what
 * got us here.
 */
export function screenShareCodecUnavailableReason(
  codec: ScreenShareCodec,
  { endToEndEncrypted = false }: { endToEndEncrypted?: boolean } = {},
): string {
  if (codec === "av1" && endToEndEncrypted) {
    return "LiveKit cannot frame-encrypt AV1 yet";
  }
  if (codec === "h265") {
    return "this WebRTC sender exposes no HEVC encoder (OBS uses a separate encoder stack)";
  }
  return "this WebRTC sender does not expose the codec";
}

export function getScreenShareQuality(): ScreenShareQuality {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SCREEN_SHARE_QUALITY };
  try {
    const stored = localStorage.getItem(SCREEN_SHARE_QUALITY_KEY);
    return stored ? normalizeScreenShareQuality(JSON.parse(stored)) : { ...DEFAULT_SCREEN_SHARE_QUALITY };
  } catch {
    return { ...DEFAULT_SCREEN_SHARE_QUALITY };
  }
}

export function rememberScreenShareQuality(value: ScreenShareQuality): ScreenShareQuality {
  const quality = normalizeScreenShareQuality(value);
  try {
    localStorage.setItem(SCREEN_SHARE_QUALITY_KEY, JSON.stringify(quality));
  } catch {
    // A denied localStorage write should not prevent screen sharing.
  }
  return quality;
}

/** Capture options used for the first share through LiveKit. */
export function screenShareCaptureOptions(quality: ScreenShareQuality): ScreenShareCaptureOptions {
  const normalized = normalizeScreenShareQuality(quality);
  const resolution = resolutionOption(normalized.resolution);
  return {
    audio: true,
    contentHint: "detail",
    resolution: {
      width: resolution.width,
      height: resolution.height,
      frameRate: normalized.frameRate,
    },
  };
}

/** Browser constraints shared by initial capture, switching, and live updates. */
export function screenShareVideoConstraints(quality: ScreenShareQuality): MediaTrackConstraints {
  const normalized = normalizeScreenShareQuality(quality);
  const resolution = resolutionOption(normalized.resolution);
  return {
    width: { ideal: resolution.width, max: resolution.width },
    height: { ideal: resolution.height, max: resolution.height },
    frameRate: { ideal: normalized.frameRate, max: normalized.frameRate },
  };
}

export function screenShareDisplayMediaOptions(
  quality: ScreenShareQuality,
): DisplayMediaStreamOptions {
  return {
    audio: true,
    video: screenShareVideoConstraints(quality),
  };
}

/** Publish policy for either one full-resolution stream or adaptive simulcast. */
export function screenSharePublishOptions(quality: ScreenShareQuality): TrackPublishOptions {
  const normalized = normalizeScreenShareQuality(quality);
  const resolution = resolutionOption(normalized.resolution);
  const lowerBitrate = Math.max(150_000, Math.round(normalized.maxBitrate / 4));
  return {
    videoCodec: normalized.codec,
    simulcast: normalized.delivery === "adaptive",
    degradationPreference: "maintain-resolution",
    screenShareEncoding: {
      maxBitrate: normalized.maxBitrate,
      maxFramerate: normalized.frameRate,
      priority: "medium",
    },
    screenShareSimulcastLayers: normalized.delivery === "adaptive"
      ? [
          new VideoPreset(
            Math.floor(resolution.width / 2),
            Math.floor(resolution.height / 2),
            lowerBitrate,
            normalized.frameRate,
            "medium",
          ),
        ]
      : [],
  };
}

export function formatScreenShareQuality(quality: ScreenShareQuality): string {
  const normalized = normalizeScreenShareQuality(quality);
  const resolution = resolutionOption(normalized.resolution);
  const bitrate = Number((normalized.maxBitrate / 1_000_000).toFixed(2));
  const codec = SCREEN_SHARE_CODECS.find((option) => option.id === normalized.codec)!.label;
  const delivery = normalized.delivery === "full" ? "full quality" : "adaptive";
  return `${resolution.width}×${resolution.height} at ${normalized.frameRate} FPS, ${bitrate} Mbps, ${codec}, ${delivery}`;
}

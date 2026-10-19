import { useEffect, useMemo, useState } from "react";
import type { LocalParticipant } from "livekit-client";
import { MonitorUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  getDesktopVideoEncoderState,
  setDesktopVideoEncoderMode,
  type DesktopVideoEncoderMode,
  type DesktopVideoEncoderState,
  type DesktopHevcScreenShareStatus,
} from "@/lib/desktop";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_SCREEN_SHARE_QUALITY,
  MAX_SCREEN_SHARE_BITRATE,
  MIN_SCREEN_SHARE_BITRATE,
  SCREEN_SHARE_BITRATE_STEP,
  SCREEN_SHARE_CODECS,
  SCREEN_SHARE_DELIVERY_MODES,
  SCREEN_SHARE_FRAME_RATES,
  SCREEN_SHARE_RESOLUTIONS,
  getScreenShareQuality,
  normalizeScreenShareQuality,
  screenShareCodecUnavailableReason,
  supportedScreenShareCodecs,
  type ScreenShareCodec,
  type ScreenShareDeliveryMode,
  type ScreenShareFrameRate,
  type ScreenShareQuality,
  type ScreenShareResolutionId,
} from "@/lib/screenShareQuality";
import {
  getPublishedScreenShareSenderStats,
  type ScreenShareSenderStats,
} from "@/lib/screenShare";
import { common, FormattedMessage, useIntl, type IntlShape } from "@/i18n";

interface ScreenShareQualityDialogProps {
  open: boolean;
  portalContainer?: HTMLElement;
  active: boolean;
  participant?: LocalParticipant;
  endToEndEncrypted?: boolean;
  customHevcAvailable?: boolean;
  nativeHevcStatus?: DesktopHevcScreenShareStatus;
  onOpenChange: (open: boolean) => void;
  onConfirm: (quality: ScreenShareQuality) => void;
}

function bitrateText(quality: ScreenShareQuality): string {
  return String(Number((quality.maxBitrate / 1_000_000).toFixed(2)));
}

const mbps = (bps: number) => (bps / 1_000_000).toFixed(2);

/** The live sender's stats as one "; "-separated line, each clause a whole message. */
function senderSummary(intl: IntlShape, stats: ScreenShareSenderStats): string {
  const parts: string[] = [];
  const width = stats.captureWidth ?? "?";
  const height = stats.captureHeight ?? "?";
  parts.push(stats.captureFrameRate
    ? intl.formatMessage(
      { id: "screenShareQualityDialog.stats.captureAt", defaultMessage: "Capture {width}×{height} at {fps} FPS" },
      { width, height, fps: Math.round(stats.captureFrameRate) },
    )
    : intl.formatMessage(
      { id: "screenShareQualityDialog.stats.capture", defaultMessage: "Capture {width}×{height}" },
      { width, height },
    ));
  const encodedFps = stats.encodedFrameRate ? Math.round(stats.encodedFrameRate) : undefined;
  if (stats.encodedWidth && stats.encodedHeight) {
    const dims = { width: stats.encodedWidth, height: stats.encodedHeight };
    parts.push(encodedFps
      ? intl.formatMessage(
        { id: "screenShareQualityDialog.stats.encodedAt", defaultMessage: "encoded {width}×{height} at {fps} FPS" },
        { ...dims, fps: encodedFps },
      )
      : intl.formatMessage(
        { id: "screenShareQualityDialog.stats.encoded", defaultMessage: "encoded {width}×{height}" },
        dims,
      ));
  } else if (encodedFps) {
    parts.push(intl.formatMessage(
      { id: "screenShareQualityDialog.stats.encodedFps", defaultMessage: "encoded at {fps} FPS" },
      { fps: encodedFps },
    ));
  }
  if (stats.codec) {
    const codec = stats.codec.toUpperCase();
    parts.push(stats.encoderImplementation
      ? intl.formatMessage(
        { id: "screenShareQualityDialog.stats.codecVia", defaultMessage: "{codec} via {encoder}" },
        { codec, encoder: stats.encoderImplementation },
      )
      : codec);
  } else if (stats.encoderImplementation) {
    parts.push(intl.formatMessage(
      { id: "screenShareQualityDialog.stats.via", defaultMessage: "via {encoder}" },
      { encoder: stats.encoderImplementation },
    ));
  }
  if (stats.actualBitrate !== undefined) {
    parts.push(intl.formatMessage(
      { id: "screenShareQualityDialog.stats.mediaSent", defaultMessage: "{mbps} Mbps media sent" },
      { mbps: mbps(stats.actualBitrate) },
    ));
  }
  if (stats.targetBitrate !== undefined) {
    parts.push(intl.formatMessage(
      { id: "screenShareQualityDialog.stats.webrtcTarget", defaultMessage: "{mbps} Mbps WebRTC target" },
      { mbps: mbps(stats.targetBitrate) },
    ));
  }
  if (stats.configuredMaxBitrate !== undefined) {
    parts.push(intl.formatMessage(
      { id: "screenShareQualityDialog.stats.ceiling", defaultMessage: "{mbps} Mbps ceiling" },
      { mbps: mbps(stats.configuredMaxBitrate) },
    ));
  }
  if (stats.qualityLimitationReason && stats.qualityLimitationReason !== "none") {
    parts.push(intl.formatMessage(
      { id: "screenShareQualityDialog.stats.limitedBy", defaultMessage: "limited by {reason}" },
      { reason: stats.qualityLimitationReason },
    ));
  }
  return parts.join("; ");
}

/** The native HEVC publisher's status, in the same shape as {@link senderSummary}. */
function nativeSummary(intl: IntlShape, status: DesktopHevcScreenShareStatus): string {
  const width = status.width ?? "?";
  const height = status.height ?? "?";
  const parts: string[] = [
    status.frameRate
      ? intl.formatMessage(
        { id: "screenShareQualityDialog.native.sizeAt", defaultMessage: "{width}×{height} at {fps} FPS" },
        { width, height, fps: status.frameRate },
      )
      : `${width}×${height}`,
  ];
  const backend = status.backend ?? "FFmpeg/VA-API";
  parts.push(status.device
    ? intl.formatMessage(
      { id: "screenShareQualityDialog.native.viaOn", defaultMessage: "H.265 via {backend} on {device}" },
      { backend, device: status.device },
    )
    : intl.formatMessage(
      { id: "screenShareQualityDialog.native.via", defaultMessage: "H.265 via {backend}" },
      { backend },
    ));
  if (status.bitrate) {
    parts.push(intl.formatMessage(
      { id: "screenShareQualityDialog.native.cbrTarget", defaultMessage: "{mbps} Mbps CBR target" },
      { mbps: mbps(status.bitrate) },
    ));
  }
  if (status.framesDropped) {
    parts.push(intl.formatMessage(
      {
        id: "screenShareQualityDialog.native.dropped",
        defaultMessage: "{count, plural, one {# frame dropped at encoder input} other {# frames dropped at encoder input}}",
      },
      { count: status.framesDropped },
    ));
  }
  return parts.join("; ");
}

function qualityForAvailableCodecs(
  quality: ScreenShareQuality,
  supported: ReadonlySet<ScreenShareCodec>,
): ScreenShareQuality {
  if (supported.has(quality.codec)) return quality;
  const fallback = SCREEN_SHARE_CODECS.find((codec) => supported.has(codec.id))?.id ??
    DEFAULT_SCREEN_SHARE_QUALITY.codec;
  return { ...quality, codec: fallback };
}

export function ScreenShareQualityDialog({
  open,
  portalContainer,
  active,
  participant,
  endToEndEncrypted = false,
  customHevcAvailable = false,
  nativeHevcStatus,
  onOpenChange,
  onConfirm,
}: ScreenShareQualityDialogProps) {
  const intl = useIntl();
  const [quality, setQuality] = useState<ScreenShareQuality>(() => getScreenShareQuality());
  const [bitrate, setBitrate] = useState(() => bitrateText(quality));
  const [senderStats, setSenderStats] = useState<ScreenShareSenderStats | null>(null);
  const [encoderState, setEncoderState] = useState<DesktopVideoEncoderState | null>(null);
  const supportedCodecs = useMemo(
    () => supportedScreenShareCodecs({ endToEndEncrypted, customHevc: customHevcAvailable }),
    [endToEndEncrypted, customHevcAvailable],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const stored = qualityForAvailableCodecs(getScreenShareQuality(), supportedCodecs);
    setQuality(stored);
    setBitrate(bitrateText(stored));
    void getDesktopVideoEncoderState()
      .then((state) => {
        if (!cancelled) setEncoderState(state);
      })
      .catch((error) => console.warn("failed to read the desktop encoder mode", error));
    return () => {
      cancelled = true;
    };
    // Keyed on `open` alone: the async H.265 probe changes `supportedCodecs` while
    // open, and re-running would discard the user's edits (`normalized` coerces).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !active || !participant) {
      setSenderStats(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void getPublishedScreenShareSenderStats(participant)
        .then((stats) => {
          if (!cancelled) setSenderStats(stats);
        })
        .catch((error) => console.warn("failed to read screen-share sender stats", error));
    };
    refresh();
    const interval = window.setInterval(refresh, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [active, open, participant]);

  const normalized = qualityForAvailableCodecs(
    normalizeScreenShareQuality({
      ...quality,
      maxBitrate: Number(bitrate) * 1_000_000,
    }),
    supportedCodecs,
  );
  if (normalized.codec === "h265" && customHevcAvailable) normalized.delivery = "full";
  const lowerBitrate = normalized.delivery === "adaptive"
    ? Math.max(150_000, normalized.maxBitrate / 4)
    : 0;
  const estimatedCeiling = (normalized.maxBitrate + lowerBitrate) / 1_000_000;
  const encoderMode = encoderState?.configured ?? encoderState?.active ?? "compatibility";
  const restartRequired = Boolean(
    encoderState?.active && encoderState.configured !== encoderState.active,
  );
  const h264BlockedByHardware =
    normalized.codec === "h264" && encoderState?.active === "hardware";

  const chooseEncoderMode = (mode: DesktopVideoEncoderMode) => {
    void setDesktopVideoEncoderMode(mode)
      .then((next) => {
        if (next) setEncoderState(next);
      })
      .catch((error) => console.warn("failed to change the desktop encoder mode", error));
  };

  const reset = () => {
    setQuality({ ...DEFAULT_SCREEN_SHARE_QUALITY });
    setBitrate(bitrateText(DEFAULT_SCREEN_SHARE_QUALITY));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={intl.formatMessage({ id: "screenShareQualityDialog.title", defaultMessage: "Screen share quality" })}
        className="sm:max-w-lg"
        portalContainer={portalContainer}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <MonitorUp className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="screenShareQualityDialog.heading" defaultMessage="screen share quality" />
          </h2>
          {/* DialogDescription wires aria-describedby, which the sr-only title doesn't. */}
          <DialogDescription className="text-sm text-muted-foreground">
            <FormattedMessage
              id="screenShareQualityDialog.description"
              defaultMessage="Choose capture and encoder limits. Full quality prevents viewers from being assigned a smaller spatial layer."
            />
          </DialogDescription>
        </div>

        <form
          className="mt-6 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            onOpenChange(false);
            onConfirm(normalized);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="screen-share-resolution">
                <FormattedMessage id="screenShareQualityDialog.label.resolution" defaultMessage="Resolution" />
              </Label>
              <Select
                value={quality.resolution}
                onValueChange={(resolution: ScreenShareResolutionId) =>
                  setQuality((current) => ({ ...current, resolution }))
                }
              >
                <SelectTrigger id="screen-share-resolution">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent portalContainer={portalContainer}>
                  {SCREEN_SHARE_RESOLUTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label} ({option.width}×{option.height})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="screen-share-frame-rate">
                <FormattedMessage id="screenShareQualityDialog.label.frameRate" defaultMessage="Frame rate" />
              </Label>
              <Select
                value={String(quality.frameRate)}
                onValueChange={(value) =>
                  setQuality((current) => ({
                    ...current,
                    frameRate: Number(value) as ScreenShareFrameRate,
                  }))
                }
              >
                <SelectTrigger id="screen-share-frame-rate">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent portalContainer={portalContainer}>
                  {SCREEN_SHARE_FRAME_RATES.map((frameRate) => (
                    <SelectItem key={frameRate} value={String(frameRate)}>
                      <FormattedMessage
                        id="screenShareQualityDialog.fps"
                        defaultMessage="{fps} FPS"
                        values={{ fps: frameRate }}
                      />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="screen-share-codec">
                <FormattedMessage id="screenShareQualityDialog.label.codec" defaultMessage="Encoder codec" />
              </Label>
              <Select
                value={quality.codec}
                onValueChange={(codec: ScreenShareCodec) =>
                  setQuality((current) => ({ ...current, codec }))
                }
              >
                <SelectTrigger id="screen-share-codec">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent portalContainer={portalContainer}>
                  {SCREEN_SHARE_CODECS.map((codec) => (
                    <SelectItem
                      key={codec.id}
                      value={codec.id}
                      disabled={!supportedCodecs.has(codec.id)}
                    >
                      {supportedCodecs.has(codec.id)
                        ? `${codec.label}: ${codec.description}`
                        : intl.formatMessage(
                          {
                            id: "screenShareQualityDialog.codecUnavailable",
                            defaultMessage: "{codec}: {description} (unavailable: {reason})",
                          },
                          {
                            codec: codec.label,
                            description: codec.description,
                            reason: screenShareCodecUnavailableReason(codec.id, { endToEndEncrypted }),
                          },
                        )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {quality.codec === "h265" && (
                <p className="text-xs text-muted-foreground">
                  {customHevcAvailable
                    ? intl.formatMessage({ id: "screenShareQualityDialog.hevcCustom", defaultMessage: "The Linux desktop uses FFmpeg with VA-API and publishes one end-to-end encrypted HEVC layer. Every viewer still needs H.265 decoding and an updated Armada client." })
                    : intl.formatMessage({ id: "screenShareQualityDialog.hevcHardware", defaultMessage: "HEVC requires hardware encoding here and H.265 decoding on every viewer. Concord calls cannot provide a VP8 fallback for an end-to-end encrypted HEVC track." })}
                </p>
              )}
              {quality.codec === "h264" && (
                <p className="text-xs text-muted-foreground">
                  <FormattedMessage
                    id="screenShareQualityDialog.h264Note"
                    defaultMessage="Encrypted H.264 uses fragmentable packetization on every desktop. On Linux, software compatibility mode avoids Mesa drivers that produced undecodable encrypted keyframes."
                  />
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="screen-share-delivery">
                <FormattedMessage id="screenShareQualityDialog.label.delivery" defaultMessage="Delivery mode" />
              </Label>
              <Select
                value={quality.delivery}
                onValueChange={(delivery: ScreenShareDeliveryMode) =>
                  setQuality((current) => ({ ...current, delivery }))
                }
              >
                <SelectTrigger id="screen-share-delivery">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent portalContainer={portalContainer}>
                  {SCREEN_SHARE_DELIVERY_MODES.map((mode) => (
                    <SelectItem key={mode.id} value={mode.id}>
                      {mode.label}: {mode.description}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {encoderState?.available && (
            <div className="space-y-2">
              <Label htmlFor="screen-share-encoder-mode">
                <FormattedMessage id="screenShareQualityDialog.label.encoderMode" defaultMessage="Linux WebRTC encoder" />
              </Label>
              <Select
                value={encoderMode}
                onValueChange={(mode: DesktopVideoEncoderMode) => chooseEncoderMode(mode)}
              >
                <SelectTrigger id="screen-share-encoder-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent portalContainer={portalContainer}>
                  <SelectItem value="compatibility">
                    <FormattedMessage id="screenShareQualityDialog.encoder.compatibility" defaultMessage="Software compatibility: reliable encrypted H.264" />
                  </SelectItem>
                  <SelectItem value="hardware">
                    <FormattedMessage id="screenShareQualityDialog.encoder.hardware" defaultMessage="Hardware acceleration: best with working VP8/VP9 drivers" />
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {restartRequired ? (
                  <FormattedMessage
                    id="screenShareQualityDialog.encoderNoteRestart"
                    defaultMessage="This is process-wide and takes effect after restarting Armada. Restart required for the selected mode."
                  />
                ) : (
                  <FormattedMessage
                    id="screenShareQualityDialog.encoderNote"
                    defaultMessage="This is process-wide and takes effect after restarting Armada."
                  />
                )}
              </p>
              {h264BlockedByHardware && (
                <p className="text-xs text-destructive">
                  <FormattedMessage
                    id="screenShareQualityDialog.h264Blocked"
                    defaultMessage="H.264 is blocked while hardware mode is active because this driver sent black encrypted frames. Select software compatibility and restart Armada first."
                  />
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="screen-share-bitrate">
              <FormattedMessage id="screenShareQualityDialog.label.bitrate" defaultMessage="Maximum bitrate (Mbps)" />
            </Label>
            <Input
              id="screen-share-bitrate"
              type="number"
              inputMode="decimal"
              min={MIN_SCREEN_SHARE_BITRATE / 1_000_000}
              max={MAX_SCREEN_SHARE_BITRATE / 1_000_000}
              step={SCREEN_SHARE_BITRATE_STEP / 1_000_000}
              value={bitrate}
              onChange={(event) => setBitrate(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              <FormattedMessage
                id="screenShareQualityDialog.estimate"
                defaultMessage="Estimated maximum encoder output: {mbps} Mbps. This is a ceiling; static content usually needs less."
                values={{ mbps: estimatedCeiling.toFixed(2) }}
              />
            </p>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="screen-share-audio">
                <FormattedMessage id="screenShareQualityDialog.label.audio" defaultMessage="Share audio" />
              </Label>
              <p className="text-xs text-muted-foreground">
                <FormattedMessage
                  id="screenShareQualityDialog.audioNote"
                  defaultMessage="Capture sound from the shared screen or window. If a share fails with “Could not start audio source,” turn this off and try again."
                />
              </p>
            </div>
            <Switch
              id="screen-share-audio"
              checked={quality.captureAudio}
              onCheckedChange={(captureAudio) =>
                setQuality((current) => ({ ...current, captureAudio }))
              }
            />
          </div>

          {active && senderStats && (
            <div className="clip-corner-lg bg-background/40 p-3 text-xs">
              <p className="font-medium text-foreground">
                <FormattedMessage id="screenShareQualityDialog.activeSender" defaultMessage="Active sender" />
              </p>
              <p className="mt-1 text-muted-foreground">
                {senderSummary(intl, senderStats)}
              </p>
            </div>
          )}

          {active && nativeHevcStatus?.active && (
            <div className="clip-corner-lg bg-background/40 p-3 text-xs">
              <p className="font-medium text-foreground">
                <FormattedMessage id="screenShareQualityDialog.activeNativeSender" defaultMessage="Active native sender" />
              </p>
              <p className="mt-1 text-muted-foreground">
                {nativeSummary(intl, nativeHevcStatus)}
              </p>
            </div>
          )}

          {nativeHevcStatus?.state === "error" && nativeHevcStatus.error && (
            <p className="text-xs text-destructive" role="alert">
              <FormattedMessage
                id="screenShareQualityDialog.publisherError"
                defaultMessage="H.265 publisher: {error}"
                values={{ error: nativeHevcStatus.error }}
              />
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              className="flex-1 clip-corner-lg"
              onClick={reset}
            >
              <FormattedMessage id="screenShareQualityDialog.resetDefaults" defaultMessage="Reset defaults" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="flex-1 clip-corner-lg"
              onClick={() => onOpenChange(false)}
            >
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button
              type="submit"
              className="flex-1 clip-corner-lg"
              disabled={h264BlockedByHardware}
            >
              {active ? intl.formatMessage({ id: "screenShareQualityDialog.apply", defaultMessage: "Apply" }) : intl.formatMessage({ id: "screenShareQualityDialog.shareScreen", defaultMessage: "Share screen" })}
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}

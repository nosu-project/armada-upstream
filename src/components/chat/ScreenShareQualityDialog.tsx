import { useEffect, useMemo, useState } from "react";
import type { LocalParticipant } from "livekit-client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

interface ScreenShareQualityDialogProps {
  open: boolean;
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

function qualityForAvailableCodecs(
  quality: ScreenShareQuality,
  supported: ReadonlySet<ScreenShareCodec>,
): ScreenShareQuality {
  if (supported.has(quality.codec)) return quality;
  const fallback = SCREEN_SHARE_CODECS.find((codec) => supported.has(codec.id))?.id ??
    DEFAULT_SCREEN_SHARE_QUALITY.codec;
  return { ...quality, codec: fallback };
}

/** Quality controls shared by browser and Electron screen capture. */
export function ScreenShareQualityDialog({
  open,
  active,
  participant,
  endToEndEncrypted = false,
  customHevcAvailable = false,
  nativeHevcStatus,
  onOpenChange,
  onConfirm,
}: ScreenShareQualityDialogProps) {
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
    const stored = qualityForAvailableCodecs(getScreenShareQuality(), supportedCodecs);
    setQuality(stored);
    setBitrate(bitrateText(stored));
    void getDesktopVideoEncoderState().then(setEncoderState);
  }, [open, supportedCodecs]);

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
    void setDesktopVideoEncoderMode(mode).then((next) => {
      if (next) setEncoderState(next);
    });
  };

  const reset = () => {
    setQuality({ ...DEFAULT_SCREEN_SHARE_QUALITY });
    setBitrate(bitrateText(DEFAULT_SCREEN_SHARE_QUALITY));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Screen share quality</DialogTitle>
          <DialogDescription>
            Choose capture and encoder limits. Full quality prevents viewers from being assigned a
            smaller spatial layer.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onOpenChange(false);
            onConfirm(normalized);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="screen-share-resolution">Resolution</Label>
              <Select
                value={quality.resolution}
                onValueChange={(resolution: ScreenShareResolutionId) =>
                  setQuality((current) => ({ ...current, resolution }))
                }
              >
                <SelectTrigger id="screen-share-resolution">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCREEN_SHARE_RESOLUTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label} ({option.width}×{option.height})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="screen-share-frame-rate">Frame rate</Label>
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
                <SelectContent>
                  {SCREEN_SHARE_FRAME_RATES.map((frameRate) => (
                    <SelectItem key={frameRate} value={String(frameRate)}>
                      {frameRate} FPS
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="screen-share-codec">Encoder codec</Label>
              <Select
                value={quality.codec}
                onValueChange={(codec: ScreenShareCodec) =>
                  setQuality((current) => ({ ...current, codec }))
                }
              >
                <SelectTrigger id="screen-share-codec">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCREEN_SHARE_CODECS.map((codec) => (
                    <SelectItem
                      key={codec.id}
                      value={codec.id}
                      disabled={!supportedCodecs.has(codec.id)}
                    >
                      {codec.label} — {codec.description}
                      {!supportedCodecs.has(codec.id) &&
                        ` (unavailable: ${screenShareCodecUnavailableReason(codec.id, {
                          endToEndEncrypted,
                          customHevc: customHevcAvailable,
                        })})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {quality.codec === "h265" && (
                <p className="text-xs text-muted-foreground">
                  {customHevcAvailable
                    ? "The Linux desktop uses FFmpeg with VA-API and publishes one end-to-end encrypted HEVC layer. Every viewer still needs H.265 decoding and an updated Armada client."
                    : "HEVC requires hardware encoding here and H.265 decoding on every viewer. Concord calls cannot provide a VP8 fallback for an end-to-end encrypted HEVC track."}
                </p>
              )}
              {quality.codec === "h264" && (
                <p className="text-xs text-muted-foreground">
                  Encrypted H.264 uses fragmentable packetization on every desktop. On Linux,
                  software compatibility mode avoids Mesa drivers that produced undecodable
                  encrypted keyframes.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="screen-share-delivery">Delivery mode</Label>
              <Select
                value={quality.delivery}
                onValueChange={(delivery: ScreenShareDeliveryMode) =>
                  setQuality((current) => ({ ...current, delivery }))
                }
              >
                <SelectTrigger id="screen-share-delivery">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCREEN_SHARE_DELIVERY_MODES.map((mode) => (
                    <SelectItem key={mode.id} value={mode.id}>
                      {mode.label} — {mode.description}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {encoderState?.available && (
            <div className="space-y-2">
              <Label htmlFor="screen-share-encoder-mode">Linux WebRTC encoder</Label>
              <Select
                value={encoderMode}
                onValueChange={(mode: DesktopVideoEncoderMode) => chooseEncoderMode(mode)}
              >
                <SelectTrigger id="screen-share-encoder-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compatibility">
                    Software compatibility — reliable encrypted H.264
                  </SelectItem>
                  <SelectItem value="hardware">
                    Hardware acceleration — best for working VP8/VP9 drivers
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                This is process-wide and takes effect after restarting Armada.
                {restartRequired && " Restart required for the selected mode."}
              </p>
              {h264BlockedByHardware && (
                <p className="text-xs text-destructive">
                  H.264 is blocked while hardware mode is active because this driver sent black
                  encrypted frames. Select software compatibility and restart Armada first.
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="screen-share-bitrate">Maximum bitrate (Mbps)</Label>
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
              Estimated maximum encoder output: {estimatedCeiling.toFixed(2)} Mbps.
              This is a ceiling; static content usually needs less.
            </p>
          </div>

          {active && senderStats && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs" aria-live="polite">
              <p className="font-medium text-foreground">Active sender</p>
              <p className="mt-1 text-muted-foreground">
                Capture {senderStats.captureWidth ?? "?"}×{senderStats.captureHeight ?? "?"}
                {senderStats.captureFrameRate ? ` at ${Math.round(senderStats.captureFrameRate)} FPS` : ""}
                {senderStats.encodedWidth && senderStats.encodedHeight
                  ? `; encoded ${senderStats.encodedWidth}×${senderStats.encodedHeight}`
                  : ""}
                {senderStats.encodedFrameRate
                  ? ` at ${Math.round(senderStats.encodedFrameRate)} FPS`
                  : ""}
                {senderStats.codec ? `; ${senderStats.codec.toUpperCase()}` : ""}
                {senderStats.encoderImplementation
                  ? ` via ${senderStats.encoderImplementation}`
                  : ""}
                {senderStats.actualBitrate !== undefined
                  ? `; ${(senderStats.actualBitrate / 1_000_000).toFixed(2)} Mbps media sent`
                  : ""}
                {senderStats.targetBitrate !== undefined
                  ? `; ${(senderStats.targetBitrate / 1_000_000).toFixed(2)} Mbps WebRTC target`
                  : ""}
                {senderStats.configuredMaxBitrate !== undefined
                  ? `; ${(senderStats.configuredMaxBitrate / 1_000_000).toFixed(2)} Mbps ceiling`
                  : ""}
                {senderStats.qualityLimitationReason && senderStats.qualityLimitationReason !== "none"
                  ? `; limited by ${senderStats.qualityLimitationReason}`
                  : ""}
              </p>
            </div>
          )}

          {active && nativeHevcStatus?.active && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs" aria-live="polite">
              <p className="font-medium text-foreground">Active native sender</p>
              <p className="mt-1 text-muted-foreground">
                {nativeHevcStatus.width ?? "?"}×{nativeHevcStatus.height ?? "?"}
                {nativeHevcStatus.frameRate ? ` at ${nativeHevcStatus.frameRate} FPS` : ""}
                {`; H.265 via ${nativeHevcStatus.backend ?? "FFmpeg/VA-API"}`}
                {nativeHevcStatus.device ? ` on ${nativeHevcStatus.device}` : ""}
                {nativeHevcStatus.bitrate
                  ? `; ${(nativeHevcStatus.bitrate / 1_000_000).toFixed(2)} Mbps CBR target`
                  : ""}
                {nativeHevcStatus.framesDropped
                  ? `; ${nativeHevcStatus.framesDropped} frames dropped at encoder input`
                  : ""}
              </p>
            </div>
          )}

          {nativeHevcStatus?.state === "error" && nativeHevcStatus.error && (
            <p className="text-xs text-destructive" role="alert">
              H.265 publisher: {nativeHevcStatus.error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={reset}>
              Reset defaults
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={h264BlockedByHardware}>
              {active ? "Apply" : "Share screen"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

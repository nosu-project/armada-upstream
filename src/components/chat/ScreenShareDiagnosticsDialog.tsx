import type { LocalAudioTrack, LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { useEffect, useState } from "react";
import { Activity } from "lucide-react";

import { ChromeDialogContent, Dialog, DialogDescription } from "@/components/ui/dialog";
import {
  getLocalScreenShareSenderStats,
  getRemoteScreenShareReceiverStats,
  type ScreenShareReceiverStats,
  type ScreenShareSenderStats,
} from "@/lib/screenShare";
import { describeOwnAudioState } from "@/lib/screenShareOwnAudio";
import type { DesktopHevcScreenShareStatus } from "@/lib/desktop";
import { FormattedMessage, useIntl } from "@/i18n";

type ScreenShareVideoTrack = LocalVideoTrack | RemoteVideoTrack;

interface ScreenShareDiagnosticsDialogProps {
  open: boolean;
  portalContainer?: HTMLElement;
  track?: ScreenShareVideoTrack;
  /** The presenter's published screen-share audio, if any (local only). */
  audioTrack?: LocalAudioTrack;
  encrypted?: boolean;
  participantName?: string;
  nativeHevcStatus?: DesktopHevcScreenShareStatus;
  onOpenChange: (open: boolean) => void;
}

function bitrate(value: number | undefined, waiting: string): string {
  return value === undefined ? waiting : `${(value / 1_000_000).toFixed(2)} Mbps`;
}

function dimensions(width: number | undefined, height: number | undefined, waiting: string): string {
  return width && height ? `${width}×${height}` : waiting;
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

/** Live WebRTC measurements available to both the presenter and every viewer. */
export function ScreenShareDiagnosticsDialog({
  open,
  portalContainer,
  track,
  audioTrack,
  encrypted,
  participantName,
  nativeHevcStatus,
  onOpenChange,
}: ScreenShareDiagnosticsDialogProps) {
  const intl = useIntl();
  const waiting = intl.formatMessage({ id: "screenShareDiagnosticsDialog.waiting", defaultMessage: "Waiting…" });
  const notReported = intl.formatMessage({ id: "screenShareDiagnosticsDialog.notReported", defaultMessage: "Browser did not report it" });
  const [sender, setSender] = useState<ScreenShareSenderStats | null>(null);
  const [receiver, setReceiver] = useState<ScreenShareReceiverStats | null>(null);
  const nativeHevc = Boolean(nativeHevcStatus?.active);
  const local = nativeHevc || Boolean(track?.isLocal);

  useEffect(() => {
    if (!open || !track) {
      setSender(null);
      setReceiver(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      const next = track.isLocal
        ? getLocalScreenShareSenderStats(track as LocalVideoTrack)
        : getRemoteScreenShareReceiverStats(track as RemoteVideoTrack);
      void next
        .then((stats) => {
          if (cancelled) return;
          if (track.isLocal) setSender(stats as ScreenShareSenderStats);
          else setReceiver(stats as ScreenShareReceiverStats | null);
        })
        .catch((error) => console.warn("failed to read screen-share diagnostics", error));
    };
    refresh();
    const interval = window.setInterval(refresh, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open, track]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "screenShareDiagnosticsDialog.title", defaultMessage: "Stream details" })} portalContainer={portalContainer}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Activity className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="screenShareDiagnosticsDialog.heading" defaultMessage="stream details" />
          </h2>
          {/* A DialogDescription rather than a bare <p>: it renders the same
              element with the same classes, and also wires aria-describedby,
              which ChromeDialogContent's sr-only title does not supply. */}
          <DialogDescription className="text-sm text-muted-foreground">
            {local ? (
              <FormattedMessage
                id="screenShareDiagnosticsDialog.descriptionSending"
                defaultMessage="{hasName, select, yes {What this client is capturing and sending for {name}.} other {What this client is capturing and sending.}} Values update once per second."
                values={{ hasName: participantName ? "yes" : "no", name: participantName }}
              />
            ) : (
              <FormattedMessage
                id="screenShareDiagnosticsDialog.descriptionReceiving"
                defaultMessage="{hasName, select, yes {What this client is receiving and decoding for {name}.} other {What this client is receiving and decoding.}} Values update once per second."
                values={{ hasName: participantName ? "yes" : "no", name: participantName }}
              />
            )}
          </DialogDescription>
        </div>

        <dl className="mt-6 clip-corner-lg bg-background/40 px-3 text-sm">
          <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.direction", defaultMessage: "Direction" })} value={local ? intl.formatMessage({ id: "screenShareDiagnosticsDialog.sending", defaultMessage: "Sending" }) : intl.formatMessage({ id: "screenShareDiagnosticsDialog.receiving", defaultMessage: "Receiving" })} />
          <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.mediaSecurity", defaultMessage: "Media security" })} value={encrypted
            ? intl.formatMessage({ id: "screenShareDiagnosticsDialog.e2ee", defaultMessage: "End-to-end encrypted" })
            : intl.formatMessage({ id: "screenShareDiagnosticsDialog.transportEncrypted", defaultMessage: "Transport encrypted" })} />
          {local ? nativeHevc ? (
            <>
              <Detail
                label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.encodedOutput", defaultMessage: "Encoded output" })}
                value={`${dimensions(nativeHevcStatus?.width, nativeHevcStatus?.height, waiting)}${nativeHevcStatus?.frameRate ? ` @ ${nativeHevcStatus.frameRate} FPS` : ""}`}
              />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.codec", defaultMessage: "Codec" })} value="H.265 / HEVC Main" />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.encoder", defaultMessage: "Encoder" })} value={nativeHevcStatus?.backend ?? "FFmpeg hevc_vaapi"} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.vaApiDevice", defaultMessage: "VA-API device" })} value={nativeHevcStatus?.device ?? waiting} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.cbrTarget", defaultMessage: "CBR target" })} value={bitrate(nativeHevcStatus?.bitrate, waiting)} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.pipeline", defaultMessage: "Pipeline" })} value={nativeHevcStatus?.pipelineStage ?? intl.formatMessage({ id: "screenShareDiagnosticsDialog.starting", defaultMessage: "Starting…" })} />
              <Detail
                label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.inputFramesMissed", defaultMessage: "Input frames / missed" })}
                value={`${nativeHevcStatus?.framesReceived ?? 0} / ${nativeHevcStatus?.framesDropped ?? 0}`}
              />
              <Detail
                label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.encoderInputRate", defaultMessage: "Encoder input rate" })}
                value={`${(nativeHevcStatus?.inputFrameRate ?? 0).toFixed(1)} FPS`}
              />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.encodedMediaRate", defaultMessage: "Encoded media rate" })} value={bitrate(nativeHevcStatus?.encodedBitrate, waiting)} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.publisherState", defaultMessage: "Publisher state" })} value={nativeHevcStatus?.state ?? waiting} />
            </>
          ) : (
            <>
              <Detail
                label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.capture", defaultMessage: "Capture" })}
                value={`${dimensions(sender?.captureWidth, sender?.captureHeight, waiting)}${sender?.captureFrameRate ? ` @ ${Math.round(sender.captureFrameRate)} FPS` : ""}`}
              />
              <Detail
                label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.encodedOutput", defaultMessage: "Encoded output" })}
                value={`${dimensions(sender?.encodedWidth, sender?.encodedHeight, waiting)}${sender?.encodedFrameRate ? ` @ ${Math.round(sender.encodedFrameRate)} FPS` : ""}`}
              />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.codec", defaultMessage: "Codec" })} value={sender?.codec?.toUpperCase() ?? waiting} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.encoder", defaultMessage: "Encoder" })} value={sender?.encoderImplementation ?? notReported} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.mediaBitrate", defaultMessage: "Media bitrate" })} value={bitrate(sender?.actualBitrate, waiting)} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.webrtcTarget", defaultMessage: "WebRTC target" })} value={bitrate(sender?.targetBitrate, waiting)} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.configuredCeiling", defaultMessage: "Configured ceiling" })} value={bitrate(sender?.configuredMaxBitrate, waiting)} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.qualityLimit", defaultMessage: "Quality limit" })} value={sender?.qualityLimitationReason ?? waiting} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.framesKeyframes", defaultMessage: "Frames / keyframes" })} value={`${sender?.framesEncoded ?? 0} / ${sender?.keyFramesEncoded ?? 0}`} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.packetsRetransmits", defaultMessage: "Packets / retransmits" })} value={`${sender?.packetsSent ?? 0} / ${sender?.retransmittedPacketsSent ?? 0}`} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.nackPliRequests", defaultMessage: "NACK / PLI requests" })} value={`${sender?.nackCount ?? 0} / ${sender?.pliCount ?? 0}`} />
              {/* Which signal let the audio out (or why none did), read from the
                  live track's settings — so a report names the basis instead of
                  guessing at it. */}
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.audio", defaultMessage: "Audio" })} value={describeOwnAudioState(audioTrack?.mediaStreamTrack)} />
            </>
          ) : (
            <>
              <Detail
                label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.decodedOutput", defaultMessage: "Decoded output" })}
                value={`${dimensions(receiver?.decodedWidth, receiver?.decodedHeight, waiting)}${receiver?.decodedFrameRate ? ` @ ${Math.round(receiver.decodedFrameRate)} FPS` : ""}`}
              />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.codec", defaultMessage: "Codec" })} value={receiver?.codec?.toUpperCase() ?? waiting} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.decoder", defaultMessage: "Decoder" })} value={receiver?.decoderImplementation ?? notReported} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.mediaBitrate", defaultMessage: "Media bitrate" })} value={bitrate(receiver?.actualBitrate, waiting)} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.framesReceivedDecoded", defaultMessage: "Frames received / decoded" })} value={`${receiver?.framesReceived ?? 0} / ${receiver?.framesDecoded ?? 0}`} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.framesDropped", defaultMessage: "Frames dropped" })} value={receiver?.framesDropped ?? 0} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.packetsReceivedLost", defaultMessage: "Packets received / lost" })} value={`${receiver?.packetsReceived ?? 0} / ${receiver?.packetsLost ?? 0}`} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.nackPliRequests", defaultMessage: "NACK / PLI requests" })} value={`${receiver?.nackCount ?? 0} / ${receiver?.pliCount ?? 0}`} />
              <Detail label={intl.formatMessage({ id: "screenShareDiagnosticsDialog.label.jitter", defaultMessage: "Jitter" })} value={receiver?.jitter === undefined ? waiting : `${(receiver.jitter * 1_000).toFixed(1)} ms`} />
            </>
          )}
        </dl>
      </ChromeDialogContent>
    </Dialog>
  );
}

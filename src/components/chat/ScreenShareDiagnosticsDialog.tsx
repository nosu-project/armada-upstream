import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getLocalScreenShareSenderStats,
  getRemoteScreenShareReceiverStats,
  type ScreenShareReceiverStats,
  type ScreenShareSenderStats,
} from "@/lib/screenShare";
import type { DesktopHevcScreenShareStatus } from "@/lib/desktop";

type ScreenShareVideoTrack = LocalVideoTrack | RemoteVideoTrack;

interface ScreenShareDiagnosticsDialogProps {
  open: boolean;
  track?: ScreenShareVideoTrack;
  encrypted?: boolean;
  participantName?: string;
  nativeHevcStatus?: DesktopHevcScreenShareStatus;
  onOpenChange: (open: boolean) => void;
}

function bitrate(value: number | undefined): string {
  return value === undefined ? "Waiting…" : `${(value / 1_000_000).toFixed(2)} Mbps`;
}

function dimensions(width: number | undefined, height: number | undefined): string {
  return width && height ? `${width}×${height}` : "Waiting…";
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
  track,
  encrypted,
  participantName,
  nativeHevcStatus,
  onOpenChange,
}: ScreenShareDiagnosticsDialogProps) {
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stream details</DialogTitle>
          <DialogDescription>
            {local ? "What this client is capturing and sending" : "What this client is receiving and decoding"}
            {participantName ? ` for ${participantName}` : ""}. Values update once per second.
          </DialogDescription>
        </DialogHeader>

        <dl className="rounded-md border bg-muted/20 px-3 text-sm">
          <Detail label="Direction" value={local ? "Sending" : "Receiving"} />
          <Detail label="Media security" value={encrypted ? "End-to-end encrypted" : "Transport encrypted"} />
          {local ? nativeHevc ? (
            <>
              <Detail
                label="Encoded output"
                value={`${dimensions(nativeHevcStatus?.width, nativeHevcStatus?.height)}${nativeHevcStatus?.frameRate ? ` @ ${nativeHevcStatus.frameRate} FPS` : ""}`}
              />
              <Detail label="Codec" value="H.265 / HEVC Main" />
              <Detail label="Encoder" value={nativeHevcStatus?.backend ?? "FFmpeg hevc_vaapi"} />
              <Detail label="VA-API device" value={nativeHevcStatus?.device ?? "Waiting…"} />
              <Detail label="CBR target" value={bitrate(nativeHevcStatus?.bitrate)} />
              <Detail label="Pipeline" value={nativeHevcStatus?.pipelineStage ?? "Starting…"} />
              <Detail
                label="Input frames / missed"
                value={`${nativeHevcStatus?.framesReceived ?? 0} / ${nativeHevcStatus?.framesDropped ?? 0}`}
              />
              <Detail
                label="Encoder input rate"
                value={`${(nativeHevcStatus?.inputFrameRate ?? 0).toFixed(1)} FPS`}
              />
              <Detail label="Encoded media rate" value={bitrate(nativeHevcStatus?.encodedBitrate)} />
              <Detail label="Publisher state" value={nativeHevcStatus?.state ?? "Waiting…"} />
            </>
          ) : (
            <>
              <Detail
                label="Capture"
                value={`${dimensions(sender?.captureWidth, sender?.captureHeight)}${sender?.captureFrameRate ? ` @ ${Math.round(sender.captureFrameRate)} FPS` : ""}`}
              />
              <Detail
                label="Encoded output"
                value={`${dimensions(sender?.encodedWidth, sender?.encodedHeight)}${sender?.encodedFrameRate ? ` @ ${Math.round(sender.encodedFrameRate)} FPS` : ""}`}
              />
              <Detail label="Codec" value={sender?.codec?.toUpperCase() ?? "Waiting…"} />
              <Detail label="Encoder" value={sender?.encoderImplementation ?? "Browser did not report it"} />
              <Detail label="Media bitrate" value={bitrate(sender?.actualBitrate)} />
              <Detail label="WebRTC target" value={bitrate(sender?.targetBitrate)} />
              <Detail label="Configured ceiling" value={bitrate(sender?.configuredMaxBitrate)} />
              <Detail label="Quality limit" value={sender?.qualityLimitationReason ?? "Waiting…"} />
              <Detail label="Frames / keyframes" value={`${sender?.framesEncoded ?? 0} / ${sender?.keyFramesEncoded ?? 0}`} />
              <Detail label="Packets / retransmits" value={`${sender?.packetsSent ?? 0} / ${sender?.retransmittedPacketsSent ?? 0}`} />
              <Detail label="NACK / PLI requests" value={`${sender?.nackCount ?? 0} / ${sender?.pliCount ?? 0}`} />
            </>
          ) : (
            <>
              <Detail
                label="Decoded output"
                value={`${dimensions(receiver?.decodedWidth, receiver?.decodedHeight)}${receiver?.decodedFrameRate ? ` @ ${Math.round(receiver.decodedFrameRate)} FPS` : ""}`}
              />
              <Detail label="Codec" value={receiver?.codec?.toUpperCase() ?? "Waiting…"} />
              <Detail label="Decoder" value={receiver?.decoderImplementation ?? "Browser did not report it"} />
              <Detail label="Media bitrate" value={bitrate(receiver?.actualBitrate)} />
              <Detail label="Frames received / decoded" value={`${receiver?.framesReceived ?? 0} / ${receiver?.framesDecoded ?? 0}`} />
              <Detail label="Frames dropped" value={receiver?.framesDropped ?? 0} />
              <Detail label="Packets received / lost" value={`${receiver?.packetsReceived ?? 0} / ${receiver?.packetsLost ?? 0}`} />
              <Detail label="NACK / PLI requests" value={`${receiver?.nackCount ?? 0} / ${receiver?.pliCount ?? 0}`} />
              <Detail label="Jitter" value={receiver?.jitter === undefined ? "Waiting…" : `${(receiver.jitter * 1_000).toFixed(1)} ms`} />
            </>
          )}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

import {
  ParticipantEvent,
  Track,
  type LocalParticipant,
  type LocalTrack,
  type LocalVideoTrack,
  type RemoteVideoTrack,
  type TrackPublishOptions,
} from "livekit-client";

import {
  getScreenShareQuality,
  normalizeScreenShareQuality,
  screenShareDisplayMediaOptions,
  screenSharePublishOptions,
  screenShareVideoConstraints,
  type ScreenShareQuality,
} from "@/lib/screenShareQuality";

type AcquireDisplayMedia = (quality: ScreenShareQuality) => Promise<MediaStream>;

export interface ScreenShareSenderStats {
  captureWidth?: number;
  captureHeight?: number;
  captureFrameRate?: number;
  encodedWidth?: number;
  encodedHeight?: number;
  encodedFrameRate?: number;
  /** Measured encoded media sent over the last stats interval, in bits/s. */
  actualBitrate?: number;
  /** WebRTC congestion controller's current encoder target, in bits/s. */
  targetBitrate?: number;
  /** User-configured maximum for the full-resolution encoding, in bits/s. */
  configuredMaxBitrate?: number;
  codec?: string;
  encoderImplementation?: string;
  qualityLimitationReason?: string;
  framesEncoded?: number;
  keyFramesEncoded?: number;
  packetsSent?: number;
  retransmittedPacketsSent?: number;
  nackCount?: number;
  pliCount?: number;
}

export interface ScreenShareReceiverStats {
  decodedWidth?: number;
  decodedHeight?: number;
  decodedFrameRate?: number;
  actualBitrate?: number;
  codec?: string;
  decoderImplementation?: string;
  framesReceived?: number;
  framesDecoded?: number;
  framesDropped?: number;
  packetsReceived?: number;
  packetsLost?: number;
  nackCount?: number;
  pliCount?: number;
  jitter?: number;
}

interface OutboundVideoStats extends RTCStats {
  kind?: string;
  mediaType?: string;
  codecId?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  bytesSent?: number;
  targetBitrate?: number;
  encoderImplementation?: string;
  qualityLimitationReason?: string;
  framesEncoded?: number;
  keyFramesEncoded?: number;
  packetsSent?: number;
  retransmittedPacketsSent?: number;
  nackCount?: number;
  pliCount?: number;
}

interface InboundVideoStats extends RTCStats {
  kind?: string;
  mediaType?: string;
  codecId?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  bytesReceived?: number;
  framesReceived?: number;
  framesDecoded?: number;
  framesDropped?: number;
  packetsReceived?: number;
  packetsLost?: number;
  nackCount?: number;
  pliCount?: number;
  jitter?: number;
  decoderImplementation?: string;
}

interface CodecStats extends RTCStats {
  mimeType?: string;
}

interface OutboundByteSample {
  timestamp: number;
  bytesSent: number;
}

const outboundSamples = new WeakMap<RTCRtpSender, OutboundByteSample>();
const inboundSamples = new WeakMap<RemoteVideoTrack, OutboundByteSample>();

type PublisherInternals = LocalParticipant & {
  engine?: {
    pcManager?: {
      publisher?: {
        getTransceivers?: () => RTCRtpTransceiver[];
      };
    };
  };
};

type PublishedLocalVideoTrack = LocalTrack & {
  publishOptions?: TrackPublishOptions;
};

function codecParameter(codec: RTCRtpCodec, name: string): string | undefined {
  const entry = codec.sdpFmtpLine
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith(`${name.toLowerCase()}=`));
  return entry?.slice(entry.indexOf("=") + 1);
}

/**
 * Keep H.264 in non-interleaved packetization mode for encrypted shares.
 * LiveKit E2EE
 * preserves the H.264 NAL header and encrypts the remaining frame. Mode 0
 * cannot fragment the resulting large encrypted NAL, so keyframes are silently
 * dropped even though an unencrypted OpenH264 loopback looks healthy. Mode 1
 * permits FU-A fragmentation and survives encrypted 1080p loopback end to end.
 * The Electron shell independently selects software encoding by default to
 * avoid Mesa hardware encoders that omit SPS/PPS from transformed keyframes.
 */
export function preferredE2eeH264Codecs(
  codecs: readonly RTCRtpCodec[],
): RTCRtpCodec[] {
  const h264 = codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/h264");
  const e2eeCompatible = h264.filter(
    (codec) => codecParameter(codec, "packetization-mode") === "1",
  );

  // Keep Chromium's original list on implementations that do not expose mode
  // 1 instead of making H.264 impossible to negotiate.
  if (e2eeCompatible.length === 0) return h264;

  const repair = codecs.filter((codec) =>
    ["video/rtx", "video/red", "video/ulpfec", "video/flexfec-03"].includes(
      codec.mimeType.toLowerCase(),
    )
  );
  return [...e2eeCompatible, ...repair];
}

function isLinuxBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /linux/i.test(nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent);
}

function configureScreenShareCodecPreferences(
  participant: LocalParticipant,
  sender: RTCRtpSender,
  track: LocalTrack,
  endToEndEncrypted: boolean,
): void {
  const videoTrack = track as PublishedLocalVideoTrack;
  if (
    track.source !== Track.Source.ScreenShare ||
    videoTrack.publishOptions?.videoCodec !== "h264" ||
    (!endToEndEncrypted && !isLinuxBrowser())
  ) {
    return;
  }

  const capabilities = globalThis.RTCRtpSender?.getCapabilities?.("video")?.codecs ?? [];
  const preferences = preferredE2eeH264Codecs(capabilities);
  if (preferences.length === 0) return;

  const transceiver = (participant as PublisherInternals).engine?.pcManager?.publisher
    ?.getTransceivers?.()
    .find((candidate) => candidate.sender === sender);
  if (!transceiver?.setCodecPreferences) return;

  try {
    // LocalSenderCreated fires before LiveKit creates its offer, which is the
    // only safe point to affect the H.264 fmtp/profile negotiation.
    transceiver.setCodecPreferences(preferences);
  } catch (error) {
    console.warn("failed to prefer a compatible H.264 screen-share profile", error);
  }
}

/** Install the pre-negotiation H.264 compatibility policy for screen shares. */
export function installScreenShareCodecPreferences(
  participant: LocalParticipant,
  { endToEndEncrypted = false }: { endToEndEncrypted?: boolean } = {},
): () => void {
  const listener = (sender: RTCRtpSender, track: LocalTrack) => {
    configureScreenShareCodecPreferences(participant, sender, track, endToEndEncrypted);
  };
  participant.on(ParticipantEvent.LocalSenderCreated, listener);
  return () => participant.off(ParticipantEvent.LocalSenderCreated, listener);
}

export function bitrateFromOutboundSamples(
  previous: OutboundByteSample | undefined,
  current: OutboundByteSample,
): number | undefined {
  if (!previous) return undefined;
  const elapsedMs = current.timestamp - previous.timestamp;
  const bytes = current.bytesSent - previous.bytesSent;
  if (elapsedMs <= 0 || bytes < 0) return undefined;
  return (bytes * 8 * 1_000) / elapsedMs;
}

async function acquireReplacementStream(quality: ScreenShareQuality): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia(
    screenShareDisplayMediaOptions(quality),
  );
  const video = stream.getVideoTracks()[0];
  if (video) video.contentHint = "detail";
  return stream;
}

async function ensureHighLayerCeiling(
  participant: LocalParticipant,
  quality: ScreenShareQuality,
): Promise<void> {
  const track = participant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
  const sender = track?.sender;
  if (!sender) return;

  try {
    const parameters = sender.getParameters();
    if (parameters.encodings.length === 0) return;
    const high = parameters.encodings.find((encoding) => encoding.rid === "f") ??
      (parameters.encodings.length === 1
        ? parameters.encodings[0]
        : parameters.encodings.reduce((best, encoding) =>
            (encoding.scaleResolutionDownBy ?? 1) < (best.scaleResolutionDownBy ?? 1)
              ? encoding
              : best,
          ));
    // Dynacast disables unused layers. Firefox represents that with a 10 bps
    // sentinel instead of `active: false`; do not accidentally turn it on.
    if (high.active === false || high.maxBitrate === 10) return;
    high.maxBitrate = quality.maxBitrate;
    high.maxFramerate = quality.frameRate;
    high.priority = "medium";
    high.networkPriority = "medium";
    await sender.setParameters(parameters);
  } catch (error) {
    // LocalVideoTrack.replaceTrack() already refreshes LiveKit's internal
    // encoding policy. This direct write is a compatibility belt for browsers
    // that expose a different encoding count (notably non-simulcast Safari).
    console.warn("failed to confirm screen-share sender ceiling", error);
  }
}

function effectiveVideoCodec(options: TrackPublishOptions | undefined): string {
  return options?.videoCodec ?? "vp8";
}

function effectiveSimulcast(options: TrackPublishOptions | undefined): boolean {
  return options?.simulcast ?? true;
}

function requiresRenegotiation(
  previous: TrackPublishOptions | undefined,
  next: TrackPublishOptions,
): boolean {
  return effectiveVideoCodec(previous) !== effectiveVideoCodec(next) ||
    effectiveSimulcast(previous) !== effectiveSimulcast(next);
}

/** Read what Chromium is actually capturing and attempting to encode. */
export async function getLocalScreenShareSenderStats(
  track: LocalVideoTrack,
): Promise<ScreenShareSenderStats> {
  const settings = track.mediaStreamTrack.getSettings();
  const result: ScreenShareSenderStats = {
    captureWidth: settings.width,
    captureHeight: settings.height,
    captureFrameRate: settings.frameRate,
    configuredMaxBitrate: track.publishOptions?.screenShareEncoding?.maxBitrate,
  };
  if (!track.sender?.getStats) return result;

  const report = await track.sender.getStats();
  const codecs = new Map<string, CodecStats>();
  const outbound: OutboundVideoStats[] = [];
  report.forEach((entry) => {
    const stats = entry as RTCStats & Partial<OutboundVideoStats & CodecStats>;
    if (stats.type === "codec") codecs.set(stats.id, stats);
    if (
      stats.type === "outbound-rtp" &&
      (stats.kind === "video" || stats.mediaType === "video")
    ) {
      outbound.push(stats);
    }
  });
  if (outbound.length === 0) return result;

  const largest = outbound.reduce((best, stats) => {
    const pixels = (stats.frameWidth ?? 0) * (stats.frameHeight ?? 0);
    const bestPixels = (best.frameWidth ?? 0) * (best.frameHeight ?? 0);
    return pixels > bestPixels ? stats : best;
  });
  const targetBitrate = outbound.reduce((total, stats) => total + (stats.targetBitrate ?? 0), 0);
  const currentSample = {
    timestamp: Math.max(...outbound.map((stats) => stats.timestamp)),
    bytesSent: outbound.reduce((total, stats) => total + (stats.bytesSent ?? 0), 0),
  };
  const actualBitrate = bitrateFromOutboundSamples(outboundSamples.get(track.sender), currentSample);
  outboundSamples.set(track.sender, currentSample);
  const codec = largest.codecId ? codecs.get(largest.codecId)?.mimeType : undefined;
  return {
    ...result,
    encodedWidth: largest.frameWidth,
    encodedHeight: largest.frameHeight,
    encodedFrameRate: largest.framesPerSecond,
    actualBitrate,
    targetBitrate: targetBitrate || undefined,
    codec: codec?.replace(/^video\//i, ""),
    encoderImplementation: largest.encoderImplementation,
    qualityLimitationReason: largest.qualityLimitationReason,
    framesEncoded: largest.framesEncoded,
    keyFramesEncoded: largest.keyFramesEncoded,
    packetsSent: largest.packetsSent,
    retransmittedPacketsSent: largest.retransmittedPacketsSent,
    nackCount: largest.nackCount,
    pliCount: largest.pliCount,
  };
}

export async function getPublishedScreenShareSenderStats(
  participant: LocalParticipant,
): Promise<ScreenShareSenderStats | null> {
  const track = participant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
  return track ? getLocalScreenShareSenderStats(track) : null;
}

/** Read the media that reached this viewer after SFU delivery and decoding. */
export async function getRemoteScreenShareReceiverStats(
  track: RemoteVideoTrack,
): Promise<ScreenShareReceiverStats | null> {
  const report = await track.getRTCStatsReport();
  if (!report) return null;
  const codecs = new Map<string, CodecStats>();
  const inbound: InboundVideoStats[] = [];
  report.forEach((entry) => {
    const stats = entry as RTCStats & Partial<InboundVideoStats & CodecStats>;
    if (stats.type === "codec") codecs.set(stats.id, stats);
    if (
      stats.type === "inbound-rtp" &&
      (stats.kind === "video" || stats.mediaType === "video")
    ) {
      inbound.push(stats);
    }
  });
  if (inbound.length === 0) return null;
  const largest = inbound.reduce((best, stats) => {
    const pixels = (stats.frameWidth ?? 0) * (stats.frameHeight ?? 0);
    const bestPixels = (best.frameWidth ?? 0) * (best.frameHeight ?? 0);
    return pixels > bestPixels ? stats : best;
  });
  const sample = {
    timestamp: Math.max(...inbound.map((stats) => stats.timestamp)),
    bytesSent: inbound.reduce((total, stats) => total + (stats.bytesReceived ?? 0), 0),
  };
  const actualBitrate = bitrateFromOutboundSamples(inboundSamples.get(track), sample);
  inboundSamples.set(track, sample);
  const codec = largest.codecId ? codecs.get(largest.codecId)?.mimeType : undefined;
  return {
    decodedWidth: largest.frameWidth,
    decodedHeight: largest.frameHeight,
    decodedFrameRate: largest.framesPerSecond,
    actualBitrate,
    codec: codec?.replace(/^video\//i, ""),
    decoderImplementation: largest.decoderImplementation,
    framesReceived: largest.framesReceived,
    framesDecoded: largest.framesDecoded,
    framesDropped: largest.framesDropped,
    packetsReceived: largest.packetsReceived,
    packetsLost: largest.packetsLost,
    nackCount: largest.nackCount,
    pliCount: largest.pliCount,
    jitter: largest.jitter,
  };
}

/** Apply new capture and sender constraints without replacing the publication. */
export async function applyPublishedScreenShareQuality(
  participant: LocalParticipant,
  value: ScreenShareQuality,
): Promise<void> {
  const quality = normalizeScreenShareQuality(value);
  const publication = participant.getTrackPublication(Track.Source.ScreenShare);
  const track = publication?.videoTrack;
  if (!publication || !track) throw new Error("No active screen share to update.");

  const mediaTrack = track.mediaStreamTrack;
  const previousConstraints = mediaTrack.getConstraints();
  const previousTrackOptions = track.publishOptions;
  const previousPublicationOptions = publication.options;
  const previousDimensions = track.lastEncodedDimensions;

  await mediaTrack.applyConstraints(screenShareVideoConstraints(quality));
  mediaTrack.contentHint = "detail";

  const publishOptions = screenSharePublishOptions(quality);
  const activePublishOptions = {
    ...publishOptions,
    simulcast: track.publishOptions?.simulcast ?? publishOptions.simulcast,
  };
  const renegotiate = requiresRenegotiation(track.publishOptions, publishOptions);
  if (renegotiate) activePublishOptions.simulcast = publishOptions.simulcast;
  track.publishOptions = { ...track.publishOptions, ...activePublishOptions };
  publication.options = { ...publication.options, ...activePublishOptions };
  // replaceTrack() recomputes LiveKit's internal simulcast encodings, but it
  // skips that work if the dimensions compare equal. The bitrate/FPS may have
  // changed independently, so force the recomputation in that case too.
  track.lastEncodedDimensions = undefined;

  try {
    if (renegotiate) {
      // Codec and simulcast topology are SDP decisions; sender.setParameters()
      // cannot change them. Republish the same capture track so the user does
      // not see another source picker and screen audio keeps playing.
      await participant.unpublishTrack(track, false);
      await participant.publishTrack(track, activePublishOptions);
    } else {
      await track.replaceTrack(mediaTrack, { userProvidedTrack: false });
    }
    await ensureHighLayerCeiling(participant, quality);
  } catch (error) {
    track.publishOptions = previousTrackOptions;
    publication.options = previousPublicationOptions;
    track.lastEncodedDimensions = previousDimensions;
    try {
      await mediaTrack.applyConstraints(previousConstraints);
    } catch {
      // Best effort: retaining the live track is more important than rollback.
    }
    if (
      renegotiate &&
      !participant.getTrackPublication(Track.Source.ScreenShare) &&
      previousPublicationOptions
    ) {
      try {
        await participant.publishTrack(track, previousPublicationOptions);
      } catch (rollbackError) {
        console.warn("failed to restore screen-share publication", rollbackError);
      }
    }
    throw error;
  }
}

/**
 * Replace an active LiveKit screen share without unpublishing its video track.
 *
 * The replacement stream is acquired first, so cancelling the picker leaves
 * the current share untouched. Keeping the existing video publication also
 * preserves its sender, subscription and E2EE state for remote participants.
 * Screen audio is replaced in place when possible and published/unpublished
 * only when the new selection adds or removes audio altogether.
 */
export async function switchPublishedScreenShare(
  participant: LocalParticipant,
  value: ScreenShareQuality = getScreenShareQuality(),
  acquire: AcquireDisplayMedia = acquireReplacementStream,
): Promise<void> {
  const quality = normalizeScreenShareQuality(value);
  const publication = participant.getTrackPublication(Track.Source.ScreenShare);
  const currentVideo = publication?.videoTrack;
  if (!publication || !currentVideo) throw new Error("No active screen share to switch.");

  const stream = await acquire(quality);
  const replacementVideo = stream.getVideoTracks()[0];
  const replacementAudio = stream.getAudioTracks()[0];
  const unusedTracks = stream
    .getTracks()
    .filter((track) => track !== replacementVideo && track !== replacementAudio);

  if (!replacementVideo) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("The selected source did not provide a video track.");
  }
  replacementVideo.contentHint = "detail";

  let videoAdopted = false;
  let audioAdopted = false;
  const previousTrackOptions = currentVideo.publishOptions;
  const previousPublicationOptions = publication.options;
  const previousDimensions = currentVideo.lastEncodedDimensions;
  try {
    const publishOptions = screenSharePublishOptions(quality);
    const activePublishOptions = {
      ...publishOptions,
      // Source switching keeps the existing negotiated codec/topology. Those
      // settings are changed through applyPublishedScreenShareQuality(), which
      // can republish deliberately when negotiation is required.
      videoCodec: currentVideo.publishOptions?.videoCodec ?? publishOptions.videoCodec,
      simulcast: currentVideo.publishOptions?.simulcast ?? publishOptions.simulcast,
    };
    currentVideo.publishOptions = { ...currentVideo.publishOptions, ...activePublishOptions };
    publication.options = { ...publication.options, ...activePublishOptions };
    currentVideo.lastEncodedDimensions = undefined;
    await currentVideo.replaceTrack(replacementVideo, { userProvidedTrack: false });
    videoAdopted = true;
    await ensureHighLayerCeiling(participant, quality);

    const currentAudio = participant.getTrackPublication(
      Track.Source.ScreenShareAudio,
    )?.track;
    if (replacementAudio && currentAudio) {
      await currentAudio.replaceTrack(replacementAudio, { userProvidedTrack: false });
      audioAdopted = true;
    } else if (replacementAudio) {
      await participant.publishTrack(replacementAudio, {
        source: Track.Source.ScreenShareAudio,
      });
      audioAdopted = true;
    } else if (currentAudio) {
      await participant.unpublishTrack(currentAudio);
    }
  } catch (error) {
    if (!videoAdopted) {
      currentVideo.publishOptions = previousTrackOptions;
      publication.options = previousPublicationOptions;
      currentVideo.lastEncodedDimensions = previousDimensions;
    }
    throw error;
  } finally {
    if (!videoAdopted) replacementVideo.stop();
    if (replacementAudio && !audioAdopted) replacementAudio.stop();
    unusedTracks.forEach((track) => track.stop());
  }
}

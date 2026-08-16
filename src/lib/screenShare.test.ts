import { Track, type LocalParticipant, type RemoteVideoTrack } from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyPublishedScreenShareQuality,
  bitrateFromOutboundSamples,
  getPublishedScreenShareSenderStats,
  getRemoteScreenShareReceiverStats,
  installScreenShareCodecPreferences,
  isScreenShareSwitchPartialFailure,
  preferredE2eeH264Codecs,
  switchPublishedScreenShare,
} from "@/lib/screenShare";
import { DEFAULT_SCREEN_SHARE_QUALITY } from "@/lib/screenShareQuality";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mediaTrack(kind: "audio" | "video") {
  return {
    kind,
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function mediaStream(video?: MediaStreamTrack, audio?: MediaStreamTrack) {
  const tracks = [video, audio].filter((track): track is MediaStreamTrack => Boolean(track));
  return {
    getTracks: () => tracks,
    getVideoTracks: () => (video ? [video] : []),
    getAudioTracks: () => (audio ? [audio] : []),
  } as unknown as MediaStream;
}

function participantWith(videoTrack: object, audioTrack?: object) {
  const videoPublication = { track: videoTrack, videoTrack, options: {} };
  return {
    getTrackPublication: vi.fn((source: Track.Source) => {
      if (source === Track.Source.ScreenShare) return videoPublication;
      if (source === Track.Source.ScreenShareAudio && audioTrack) return { track: audioTrack };
      return undefined;
    }),
    publishTrack: vi.fn(async () => ({})),
    unpublishTrack: vi.fn(async () => ({})),
  } as unknown as LocalParticipant;
}

function senderWith(encodings: RTCRtpEncodingParameters[]) {
  const parameters = { encodings } as RTCRtpSendParameters;
  return {
    encodings,
    getParameters: vi.fn(() => parameters),
    setParameters: vi.fn(async () => {}),
  };
}

describe("switchPublishedScreenShare", () => {
  it("replaces active video and audio tracks without unpublishing them", async () => {
    const currentVideo = { replaceTrack: vi.fn(async () => {}) };
    const currentAudio = { replaceTrack: vi.fn(async () => {}) };
    const participant = participantWith(currentVideo, currentAudio);
    const video = mediaTrack("video");
    const audio = mediaTrack("audio");

    await switchPublishedScreenShare(
      participant,
      DEFAULT_SCREEN_SHARE_QUALITY,
      async () => mediaStream(video, audio),
    );

    expect(currentVideo.replaceTrack).toHaveBeenCalledWith(video, {
      userProvidedTrack: false,
    });
    expect(currentAudio.replaceTrack).toHaveBeenCalledWith(audio, {
      userProvidedTrack: false,
    });
    expect(participant.publishTrack).not.toHaveBeenCalled();
    expect(participant.unpublishTrack).not.toHaveBeenCalled();
    expect(video.stop).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it("adds screen audio when the prior share was video-only", async () => {
    const currentVideo = { replaceTrack: vi.fn(async () => {}) };
    const participant = participantWith(currentVideo);
    const video = mediaTrack("video");
    const audio = mediaTrack("audio");

    await switchPublishedScreenShare(
      participant,
      DEFAULT_SCREEN_SHARE_QUALITY,
      async () => mediaStream(video, audio),
    );

    expect(participant.publishTrack).toHaveBeenCalledWith(audio, {
      source: Track.Source.ScreenShareAudio,
    });
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it("removes only screen audio when the replacement is video-only", async () => {
    const currentVideo = { replaceTrack: vi.fn(async () => {}) };
    const currentAudio = { replaceTrack: vi.fn(async () => {}) };
    const participant = participantWith(currentVideo, currentAudio);
    const video = mediaTrack("video");

    await switchPublishedScreenShare(
      participant,
      DEFAULT_SCREEN_SHARE_QUALITY,
      async () => mediaStream(video),
    );

    expect(participant.unpublishTrack).toHaveBeenCalledWith(currentAudio);
    expect(currentVideo.replaceTrack).toHaveBeenCalledOnce();
  });

  it("leaves the active publication untouched when source selection is cancelled", async () => {
    const currentVideo = { replaceTrack: vi.fn(async () => {}) };
    const currentAudio = { replaceTrack: vi.fn(async () => {}) };
    const participant = participantWith(currentVideo, currentAudio);
    const cancelled = new DOMException("cancelled", "NotAllowedError");

    await expect(
      switchPublishedScreenShare(
        participant,
        DEFAULT_SCREEN_SHARE_QUALITY,
        async () => {
          throw cancelled;
        },
      ),
    ).rejects.toBe(cancelled);

    expect(currentVideo.replaceTrack).not.toHaveBeenCalled();
    expect(currentAudio.replaceTrack).not.toHaveBeenCalled();
    expect(participant.publishTrack).not.toHaveBeenCalled();
    expect(participant.unpublishTrack).not.toHaveBeenCalled();
  });

  it("stops an unadopted replacement when swapping the sender fails", async () => {
    const currentVideo = {
      replaceTrack: vi.fn(async () => {
        throw new Error("sender closed");
      }),
    };
    const participant = participantWith(currentVideo);
    const video = mediaTrack("video");
    const audio = mediaTrack("audio");

    await expect(
      switchPublishedScreenShare(
        participant,
        DEFAULT_SCREEN_SHARE_QUALITY,
        async () => mediaStream(video, audio),
      ),
    ).rejects.toThrow("sender closed");

    expect(video.stop).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalledOnce();
  });

  it("applies capture constraints and refreshes publish encodings in place", async () => {
    const media = {
      applyConstraints: vi.fn(async () => {}),
      getConstraints: vi.fn(() => ({})),
      getSettings: vi.fn(() => ({ width: 1920, height: 1080, frameRate: 30 })),
      contentHint: "",
    } as unknown as MediaStreamTrack;
    const currentVideo = {
      mediaStreamTrack: media,
      publishOptions: { videoCodec: "vp8", simulcast: false },
      lastEncodedDimensions: { width: 1920, height: 1080 },
      replaceTrack: vi.fn(async () => {}),
    };
    const participant = participantWith(currentVideo);
    const quality = {
      resolution: "1440p" as const,
      frameRate: 60 as const,
      codec: "vp8" as const,
      delivery: "full" as const,
      maxBitrate: 10_000_000,
    };

    await applyPublishedScreenShareQuality(participant, quality);

    expect(media.applyConstraints).toHaveBeenCalledWith({
      width: { ideal: 2560, max: 2560 },
      height: { ideal: 1440, max: 1440 },
      frameRate: { ideal: 60, max: 60 },
    });
    expect(media.contentHint).toBe("detail");
    expect(currentVideo.publishOptions).toMatchObject({
      screenShareEncoding: { maxBitrate: 10_000_000, maxFramerate: 60 },
    });
    expect(currentVideo.lastEncodedDimensions).toBeUndefined();
    expect(currentVideo.replaceTrack).toHaveBeenCalledWith(media, {
      userProvidedTrack: false,
    });
  });

  it("republishes the existing capture when codec or delivery topology changes", async () => {
    const media = {
      applyConstraints: vi.fn(async () => {}),
      getConstraints: vi.fn(() => ({})),
      getSettings: vi.fn(() => ({ width: 1920, height: 1080, frameRate: 30 })),
      contentHint: "",
    } as unknown as MediaStreamTrack;
    const currentVideo = {
      mediaStreamTrack: media,
      publishOptions: { videoCodec: "vp8", simulcast: true },
      lastEncodedDimensions: { width: 1920, height: 1080 },
      replaceTrack: vi.fn(async () => {}),
    };
    const participant = participantWith(currentVideo);

    await applyPublishedScreenShareQuality(participant, {
      ...DEFAULT_SCREEN_SHARE_QUALITY,
      codec: "vp9",
      delivery: "full",
    });

    expect(participant.unpublishTrack).toHaveBeenCalledWith(currentVideo, false);
    expect(participant.publishTrack).toHaveBeenCalledWith(
      currentVideo,
      expect.objectContaining({ videoCodec: "vp9", simulcast: false }),
    );
    expect(currentVideo.replaceTrack).not.toHaveBeenCalled();
  });

  it("reports that the source changed when only its audio could not follow", async () => {
    const currentVideo = { replaceTrack: vi.fn(async () => {}) };
    const currentAudio = {
      replaceTrack: vi.fn(async () => {
        throw new Error("audio sender closed");
      }),
    };
    const participant = participantWith(currentVideo, currentAudio);
    const video = mediaTrack("video");
    const audio = mediaTrack("audio");

    // The video swap already succeeded, so the caller must not be told the
    // previous share survived — the new source is live and silent.
    await expect(
      switchPublishedScreenShare(
        participant,
        DEFAULT_SCREEN_SHARE_QUALITY,
        async () => mediaStream(video, audio),
      ),
    ).rejects.toMatchObject({
      videoAdopted: true,
      message: expect.stringContaining("audio"),
    });

    expect(currentVideo.replaceTrack).toHaveBeenCalledWith(video, {
      userProvidedTrack: false,
    });
    expect(video.stop).not.toHaveBeenCalled();
  });

  it("does not claim the previous share survived a failed source swap", async () => {
    const currentVideo = { replaceTrack: vi.fn(async () => {}) };
    const participant = participantWith(currentVideo);
    const video = mediaTrack("video");
    const audio = mediaTrack("audio");
    (participant.publishTrack as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("audio publish refused"),
    );

    const error = await switchPublishedScreenShare(
      participant,
      DEFAULT_SCREEN_SHARE_QUALITY,
      async () => mediaStream(video, audio),
    ).catch((thrown: unknown) => thrown);

    expect(isScreenShareSwitchPartialFailure(error)).toBe(true);
  });
});

describe("ensureHighLayerCeiling", () => {
  function trackWithSender(sender: ReturnType<typeof senderWith>) {
    const media = {
      applyConstraints: vi.fn(async () => {}),
      getConstraints: vi.fn(() => ({})),
      getSettings: vi.fn(() => ({ width: 1920, height: 1080, frameRate: 30 })),
      contentHint: "",
    } as unknown as MediaStreamTrack;
    return {
      mediaStreamTrack: media,
      sender,
      publishOptions: { videoCodec: "vp8", simulcast: false },
      replaceTrack: vi.fn(async () => {}),
    };
  }

  it("raises the ceiling of the full-resolution simulcast layer", async () => {
    const sender = senderWith([
      { rid: "h", maxBitrate: 1_000_000, scaleResolutionDownBy: 2 },
      { rid: "f", maxBitrate: 3_000_000, scaleResolutionDownBy: 1 },
    ]);
    const currentVideo = trackWithSender(sender);
    const participant = participantWith(currentVideo);

    await applyPublishedScreenShareQuality(participant, {
      ...DEFAULT_SCREEN_SHARE_QUALITY,
      delivery: "full",
      frameRate: 60,
      maxBitrate: 12_000_000,
    });

    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(sender.encodings[1]).toMatchObject({
      maxBitrate: 12_000_000,
      maxFramerate: 60,
    });
    expect(sender.encodings[0].maxBitrate).toBe(1_000_000);
  });

  it("still records the ceiling on a layer dynacast has paused", async () => {
    // Dynacast turns unused layers off with `active: false` and turns them back
    // on by setting `active` alone — it never restores maxBitrate. Skipping the
    // write here would cap the layer at its old ceiling for the rest of the
    // share, which is the common case for a presenter nobody has subscribed to
    // at full resolution yet.
    const sender = senderWith([{ rid: "f", active: false, maxBitrate: 3_000_000 }]);
    const currentVideo = trackWithSender(sender);
    const participant = participantWith(currentVideo);

    await applyPublishedScreenShareQuality(participant, {
      ...DEFAULT_SCREEN_SHARE_QUALITY,
      delivery: "full",
      maxBitrate: 12_000_000,
    });

    expect(sender.encodings[0]).toMatchObject({ active: false, maxBitrate: 12_000_000 });
    expect(sender.setParameters).toHaveBeenCalledOnce();
  });

  it("leaves Firefox's 10 bps disabled-layer sentinel alone", async () => {
    const sender = senderWith([{ rid: "f", maxBitrate: 10 }]);
    const currentVideo = trackWithSender(sender);
    const participant = participantWith(currentVideo);

    await applyPublishedScreenShareQuality(participant, {
      ...DEFAULT_SCREEN_SHARE_QUALITY,
      delivery: "full",
      maxBitrate: 12_000_000,
    });

    expect(sender.encodings[0].maxBitrate).toBe(10);
    expect(sender.setParameters).not.toHaveBeenCalled();
  });
});

describe("applyPublishedScreenShareQuality rollback", () => {
  it("restores the capture the track was actually producing", async () => {
    // getConstraints() reports only what applyConstraints() previously set, so
    // a capture straight out of getDisplayMedia() reports nothing. Replaying
    // that would lift the caps instead of restoring them.
    const media = {
      applyConstraints: vi.fn(async () => {}),
      getConstraints: vi.fn(() => ({})),
      getSettings: vi.fn(() => ({ width: 1920, height: 1080, frameRate: 30 })),
      contentHint: "",
    } as unknown as MediaStreamTrack;
    const currentVideo = {
      mediaStreamTrack: media,
      publishOptions: { videoCodec: "vp8", simulcast: false },
      lastEncodedDimensions: { width: 1920, height: 1080 },
      replaceTrack: vi.fn(async () => {
        throw new Error("sender closed");
      }),
    };
    const participant = participantWith(currentVideo);

    await expect(
      applyPublishedScreenShareQuality(participant, {
        ...DEFAULT_SCREEN_SHARE_QUALITY,
        resolution: "1440p",
        frameRate: 60,
      }),
    ).rejects.toThrow("sender closed");

    expect(media.applyConstraints).toHaveBeenLastCalledWith({
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
    });
    expect(currentVideo.publishOptions).toEqual({ videoCodec: "vp8", simulcast: false });
    expect(currentVideo.lastEncodedDimensions).toEqual({ width: 1920, height: 1080 });
  });

  it("replays the constraints a previous update applied", async () => {
    const applied = {
      width: { ideal: 2560, max: 2560 },
      height: { ideal: 1440, max: 1440 },
      frameRate: { ideal: 60, max: 60 },
    };
    const media = {
      applyConstraints: vi.fn(async () => {}),
      getConstraints: vi.fn(() => applied),
      getSettings: vi.fn(() => ({ width: 2560, height: 1440, frameRate: 60 })),
      contentHint: "",
    } as unknown as MediaStreamTrack;
    const currentVideo = {
      mediaStreamTrack: media,
      publishOptions: { videoCodec: "vp8", simulcast: false },
      replaceTrack: vi.fn(async () => {
        throw new Error("sender closed");
      }),
    };
    const participant = participantWith(currentVideo);

    await expect(
      applyPublishedScreenShareQuality(participant, DEFAULT_SCREEN_SHARE_QUALITY),
    ).rejects.toThrow("sender closed");

    expect(media.applyConstraints).toHaveBeenLastCalledWith(applied);
  });
});

describe("getPublishedScreenShareSenderStats", () => {
  it("derives measured media bitrate from cumulative outbound bytes", () => {
    expect(
      bitrateFromOutboundSamples(
        { timestamp: 1_000, bytesSent: 1_000_000 },
        { timestamp: 2_000, bytesSent: 1_750_000 },
      ),
    ).toBe(6_000_000);
    expect(
      bitrateFromOutboundSamples(undefined, { timestamp: 2_000, bytesSent: 1_750_000 }),
    ).toBeUndefined();
    expect(
      bitrateFromOutboundSamples(
        { timestamp: 2_000, bytesSent: 1_750_000 },
        { timestamp: 1_000, bytesSent: 10 },
      ),
    ).toBeUndefined();
  });

  it("reports capture, negotiated codec, encoder, and outbound target", async () => {
    const report = new Map<string, object>([
      ["codec", { id: "codec", type: "codec", mimeType: "video/VP9" }],
      [
        "outbound",
        {
          id: "outbound",
          type: "outbound-rtp",
          kind: "video",
          codecId: "codec",
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 30,
          targetBitrate: 4_500_000,
          bytesSent: 1_000_000,
          timestamp: 1_000,
          encoderImplementation: "ExternalEncoder",
          qualityLimitationReason: "none",
        },
      ],
    ]);
    const currentVideo = {
      mediaStreamTrack: {
        getSettings: () => ({ width: 2560, height: 1440, frameRate: 60 }),
      },
      sender: { getStats: vi.fn(async () => report) },
      publishOptions: { screenShareEncoding: { maxBitrate: 7_000_000 } },
    };
    const participant = participantWith(currentVideo);

    await expect(getPublishedScreenShareSenderStats(participant)).resolves.toMatchObject({
      captureWidth: 2560,
      captureHeight: 1440,
      captureFrameRate: 60,
      encodedWidth: 1920,
      encodedHeight: 1080,
      encodedFrameRate: 30,
      targetBitrate: 4_500_000,
      configuredMaxBitrate: 7_000_000,
      codec: "VP9",
      encoderImplementation: "ExternalEncoder",
      qualityLimitationReason: "none",
    });
  });

  it("reports the codec, decoded output, receive bitrate, and loss seen by a viewer", async () => {
    let sample = 0;
    const track = {
      getRTCStatsReport: vi.fn(async () => {
        sample += 1;
        return new Map<string, object>([
          ["codec", { id: "codec", type: "codec", mimeType: "video/H264" }],
          [
            "inbound",
            {
              id: "inbound",
              type: "inbound-rtp",
              kind: "video",
              codecId: "codec",
              frameWidth: 1920,
              frameHeight: 1080,
              framesPerSecond: 30,
              bytesReceived: sample === 1 ? 1_000 : 1_001_000,
              timestamp: sample * 1_000,
              framesReceived: 200,
              framesDecoded: 198,
              framesDropped: 2,
              packetsReceived: 1_500,
              packetsLost: 3,
              nackCount: 4,
              pliCount: 1,
              jitter: 0.006,
              decoderImplementation: "FFmpegVideoDecoder",
            },
          ],
        ]) as unknown as RTCStatsReport;
      }),
    } as unknown as RemoteVideoTrack;

    await getRemoteScreenShareReceiverStats(track);
    await expect(getRemoteScreenShareReceiverStats(track)).resolves.toMatchObject({
      decodedWidth: 1920,
      decodedHeight: 1080,
      decodedFrameRate: 30,
      actualBitrate: 8_000_000,
      codec: "H264",
      decoderImplementation: "FFmpegVideoDecoder",
      framesReceived: 200,
      framesDecoded: 198,
      framesDropped: 2,
      packetsReceived: 1_500,
      packetsLost: 3,
      nackCount: 4,
      pliCount: 1,
      jitter: 0.006,
    });
  });
});

describe("preferredE2eeH264Codecs", () => {
  it("uses mode 1 so encrypted H.264 keyframes can fragment", () => {
    const codecs: RTCRtpCodec[] = [
      { mimeType: "video/H264", clockRate: 90_000, sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f" },
      { mimeType: "video/H264", clockRate: 90_000, sdpFmtpLine: "packetization-mode=0;profile-level-id=42e01f" },
      { mimeType: "video/H264", clockRate: 90_000, sdpFmtpLine: "packetization-mode=1;profile-level-id=640033" },
      { mimeType: "video/rtx", clockRate: 90_000 },
      { mimeType: "video/VP8", clockRate: 90_000 },
    ];

    expect(preferredE2eeH264Codecs(codecs)).toEqual([
      codecs[0],
      codecs[2],
      codecs[3],
    ]);
  });

  it("keeps retransmission and FEC when no sender exposes mode 1", () => {
    // Dropping video/rtx from a setCodecPreferences() list negotiates the share
    // without NACK retransmission, so the fallback would be worse on a lossy
    // link than the path it is falling back from.
    const codecs: RTCRtpCodec[] = [
      { mimeType: "video/H264", clockRate: 90_000, sdpFmtpLine: "packetization-mode=0;profile-level-id=42e01f" },
      { mimeType: "video/rtx", clockRate: 90_000 },
      { mimeType: "video/red", clockRate: 90_000 },
      { mimeType: "video/ulpfec", clockRate: 90_000 },
      { mimeType: "video/VP8", clockRate: 90_000 },
    ];

    expect(preferredE2eeH264Codecs(codecs)).toEqual([
      codecs[0],
      codecs[1],
      codecs[2],
      codecs[3],
    ]);
  });

  it("applies the preference before a Linux H.264 screen sender negotiates", () => {
    const e2eeCompatible = {
      mimeType: "video/H264",
      clockRate: 90_000,
      sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f",
    };
    vi.stubGlobal("navigator", { platform: "Linux x86_64", userAgent: "" });
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({ codecs: [e2eeCompatible], headerExtensions: [] }),
    });
    const sender = {} as RTCRtpSender;
    const setCodecPreferences = vi.fn();
    let listener: ((sender: RTCRtpSender, track: object) => void) | undefined;
    const participant = {
      on: vi.fn((_event, next) => {
        listener = next;
      }),
      off: vi.fn(),
      engine: {
        pcManager: {
          publisher: {
            getTransceivers: () => [{ sender, setCodecPreferences }],
          },
        },
      },
    } as unknown as LocalParticipant;
    const cleanup = installScreenShareCodecPreferences(participant);

    listener?.(sender, {
      source: Track.Source.ScreenShare,
      publishOptions: { videoCodec: "h264" },
    });

    expect(setCodecPreferences).toHaveBeenCalledWith([e2eeCompatible]);
    cleanup();
    expect(participant.off).toHaveBeenCalledOnce();
  });

  it("applies the packetization preference to encrypted H.264 on Windows", () => {
    const e2eeCompatible = {
      mimeType: "video/H264",
      clockRate: 90_000,
      sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f",
    };
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "" });
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({ codecs: [e2eeCompatible], headerExtensions: [] }),
    });
    const sender = {} as RTCRtpSender;
    const setCodecPreferences = vi.fn();
    let listener: ((sender: RTCRtpSender, track: object) => void) | undefined;
    const participant = {
      on: vi.fn((_event, next) => {
        listener = next;
      }),
      off: vi.fn(),
      engine: {
        pcManager: {
          publisher: {
            getTransceivers: () => [{ sender, setCodecPreferences }],
          },
        },
      },
    } as unknown as LocalParticipant;
    const cleanup = installScreenShareCodecPreferences(participant, {
      endToEndEncrypted: true,
    });

    listener?.(sender, {
      source: Track.Source.ScreenShare,
      publishOptions: { videoCodec: "h264" },
    });

    expect(setCodecPreferences).toHaveBeenCalledWith([e2eeCompatible]);
    cleanup();
  });

  it("does not change an unencrypted Windows sender", () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "" });
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [{
          mimeType: "video/H264",
          clockRate: 90_000,
          sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f",
        }],
      }),
    });
    const sender = {} as RTCRtpSender;
    const setCodecPreferences = vi.fn();
    let listener: ((sender: RTCRtpSender, track: object) => void) | undefined;
    const participant = {
      on: vi.fn((_event, next) => {
        listener = next;
      }),
      off: vi.fn(),
      engine: {
        pcManager: {
          publisher: {
            getTransceivers: () => [{ sender, setCodecPreferences }],
          },
        },
      },
    } as unknown as LocalParticipant;
    const cleanup = installScreenShareCodecPreferences(participant);

    listener?.(sender, {
      source: Track.Source.ScreenShare,
      publishOptions: { videoCodec: "h264" },
    });

    expect(setCodecPreferences).not.toHaveBeenCalled();
    cleanup();
  });
});

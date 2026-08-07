import { Track, type LocalParticipant } from "livekit-client";
import { describe, expect, it, vi } from "vitest";

import { switchPublishedScreenShare } from "@/lib/screenShare";

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
  return {
    getTrackPublication: vi.fn((source: Track.Source) => {
      if (source === Track.Source.ScreenShare) return { track: videoTrack };
      if (source === Track.Source.ScreenShareAudio && audioTrack) return { track: audioTrack };
      return undefined;
    }),
    publishTrack: vi.fn(async () => ({})),
    unpublishTrack: vi.fn(async () => ({})),
  } as unknown as LocalParticipant;
}

describe("switchPublishedScreenShare", () => {
  it("replaces active video and audio tracks without unpublishing them", async () => {
    const currentVideo = { replaceTrack: vi.fn(async () => {}) };
    const currentAudio = { replaceTrack: vi.fn(async () => {}) };
    const participant = participantWith(currentVideo, currentAudio);
    const video = mediaTrack("video");
    const audio = mediaTrack("audio");

    await switchPublishedScreenShare(participant, async () => mediaStream(video, audio));

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

    await switchPublishedScreenShare(participant, async () => mediaStream(video, audio));

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

    await switchPublishedScreenShare(participant, async () => mediaStream(video));

    expect(participant.unpublishTrack).toHaveBeenCalledWith(currentAudio);
    expect(currentVideo.replaceTrack).toHaveBeenCalledOnce();
  });

  it("leaves the active publication untouched when source selection is cancelled", async () => {
    const currentVideo = { replaceTrack: vi.fn(async () => {}) };
    const currentAudio = { replaceTrack: vi.fn(async () => {}) };
    const participant = participantWith(currentVideo, currentAudio);
    const cancelled = new DOMException("cancelled", "NotAllowedError");

    await expect(
      switchPublishedScreenShare(participant, async () => {
        throw cancelled;
      }),
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
      switchPublishedScreenShare(participant, async () => mediaStream(video, audio)),
    ).rejects.toThrow("sender closed");

    expect(video.stop).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalledOnce();
  });
});

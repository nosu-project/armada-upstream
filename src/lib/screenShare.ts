import { Track, type LocalParticipant } from "livekit-client";

type AcquireDisplayMedia = () => Promise<MediaStream>;

function acquireReplacementStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
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
  acquire: AcquireDisplayMedia = acquireReplacementStream,
): Promise<void> {
  const currentVideo = participant.getTrackPublication(Track.Source.ScreenShare)?.track;
  if (!currentVideo) throw new Error("No active screen share to switch.");

  const stream = await acquire();
  const replacementVideo = stream.getVideoTracks()[0];
  const replacementAudio = stream.getAudioTracks()[0];
  const unusedTracks = stream
    .getTracks()
    .filter((track) => track !== replacementVideo && track !== replacementAudio);

  if (!replacementVideo) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("The selected source did not provide a video track.");
  }

  let videoAdopted = false;
  let audioAdopted = false;
  try {
    await currentVideo.replaceTrack(replacementVideo, { userProvidedTrack: false });
    videoAdopted = true;

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
  } finally {
    if (!videoAdopted) replacementVideo.stop();
    if (replacementAudio && !audioAdopted) replacementAudio.stop();
    unusedTracks.forEach((track) => track.stop());
  }
}

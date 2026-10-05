import { AudioTrack, useRoomContext, useTracks } from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";
import type { Participant, RemoteTrackPublication, TrackPublication } from "livekit-client";
import { useEffect, useMemo } from "react";

import {
  ScreenShareWatchContext,
  streamOwnerKey,
  useScreenShareWatch,
} from "@/contexts/ScreenShareWatchContext";
import { useVoiceIdentity } from "@/contexts/VoiceIdentityContext";
import { useCall } from "@/hooks/useCall";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";

function isStreamSource(source: Track.Source): boolean {
  return source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio;
}

/**
 * Keeps LiveKit's subscriptions in line with the streams this client watches
 * (held by CallProvider, so the sidebar can tune in): a remote screen share,
 * video and audio, is subscribed only while watched. The room auto-subscribes
 * everything else, so an unwatched stream is turned away as it is published,
 * or as soon as it lands.
 */
export function ScreenShareWatchProvider({ children }: { children: React.ReactNode }) {
  const room = useRoomContext();
  const resolveIdentity = useVoiceIdentity();
  const { watchStream: watch, stopWatchingStream: stopWatching } = useCall();
  const { watchedStreams: watching } = useVoiceActivity();

  useEffect(() => {
    const apply = () => {
      for (const participant of room.remoteParticipants.values()) {
        const want = watching.has(streamOwnerKey(participant.identity, resolveIdentity));
        for (const publication of participant.trackPublications.values()) {
          if (isStreamSource(publication.source) && publication.isDesired !== want) {
            publication.setSubscribed(want);
          }
        }
      }
    };
    apply();
    room
      .on(RoomEvent.TrackPublished, apply)
      .on(RoomEvent.TrackSubscribed, apply)
      .on(RoomEvent.Connected, apply)
      .on(RoomEvent.Reconnected, apply);
    return () => {
      room
        .off(RoomEvent.TrackPublished, apply)
        .off(RoomEvent.TrackSubscribed, apply)
        .off(RoomEvent.Connected, apply)
        .off(RoomEvent.Reconnected, apply);
    };
  }, [room, watching, resolveIdentity]);

  // An ended stream ends the watch: a restarted share is a fresh invitation.
  useEffect(() => {
    const onUnpublished = (publication: RemoteTrackPublication | TrackPublication, participant: Participant) => {
      if (publication.source === Track.Source.ScreenShare) {
        stopWatching(streamOwnerKey(participant.identity, resolveIdentity));
      }
    };
    room.on(RoomEvent.TrackUnpublished, onUnpublished);
    return () => {
      room.off(RoomEvent.TrackUnpublished, onUnpublished);
    };
  }, [room, resolveIdentity, stopWatching]);

  const value = useMemo(() => ({ watching, watch, stopWatching }), [watching, watch, stopWatching]);
  return <ScreenShareWatchContext.Provider value={value}>{children}</ScreenShareWatchContext.Provider>;
}

/**
 * LiveKit's RoomAudioRenderer, minus the screen audio of streams not being
 * watched, so one that lands before its unsubscribe never reaches a speaker.
 */
export function CallAudioRenderer() {
  const { watching } = useScreenShareWatch();
  const resolveIdentity = useVoiceIdentity();
  const tracks = useTracks(
    [Track.Source.Microphone, Track.Source.ScreenShareAudio, Track.Source.Unknown],
    { updateOnlyOn: [], onlySubscribed: true },
  ).filter(
    (ref) =>
      !ref.participant.isLocal &&
      ref.publication.kind === Track.Kind.Audio &&
      (ref.source !== Track.Source.ScreenShareAudio ||
        watching.has(streamOwnerKey(ref.participant.identity, resolveIdentity))),
  );
  return (
    <div style={{ display: "none" }}>
      {tracks.map((ref) => (
        <AudioTrack key={`${ref.participant.identity}:${ref.publication.trackSid}`} trackRef={ref} />
      ))}
    </div>
  );
}

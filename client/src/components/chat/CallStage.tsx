import {
  useParticipants,
  useSpeakingParticipants,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import type { TrackReference } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { Track } from "livekit-client";
import { MicOff, ScreenShare, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { pubkeyFromLivekitIdentity } from "@/hooks/useLivekit";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import {
  getAvatarShape,
  shapedAvatarSpeakingStyle,
} from "@/lib/avatarShape";
import { cn } from "@/lib/utils";

/**
 * The top-of-chat host into which the active call's stage portals. A chat
 * surface renders this when its conversation matches the active call
 * (`active`), registering its DOM node as the stage slot; the persistent
 * `CallStage` (which lives in the LiveKitRoom) renders into it. When not active
 * it renders nothing, so non-matching surfaces never show the stage.
 */
export function CallStageSlot({ active }: { active: boolean }) {
  const { registerCallStageSlot } = useCall();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    return registerCallStageSlot(el);
  }, [active, registerCallStageSlot]);

  if (!active) return null;
  return <div ref={ref} className="shrink-0" />;
}


/** A single video tile (camera or screenshare) for one participant track. */
function VideoTile({ trackRef }: { trackRef: TrackReference }) {
  const participant = trackRef.participant;
  const pubkey = pubkeyFromLivekitIdentity(participant.identity);
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(pubkey, metadata);
  const shape = getAvatarShape(metadata);
  const isScreenShare = trackRef.source === Track.Source.ScreenShare;
  // A placeholder (no track) means the participant has the source but the track
  // isn't subscribed yet — show their avatar instead of video.
  const hasVideo = Boolean(trackRef.publication?.track);
  const isLocal = participant.isLocal;

  return (
    <div className="relative flex items-center justify-center bg-black rounded-lg overflow-hidden ring-1 ring-white/10 aspect-video">
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef}
          // Mirror your own camera (not screenshare) so it reads naturally.
          className={cn(
            "h-full w-full",
            isScreenShare ? "object-contain" : "object-cover",
            isLocal && !isScreenShare && "-scale-x-100",
          )}
        />
      ) : (
        <Avatar shape={shape} className="size-16">
          <AvatarImage src={metadata?.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-xl">
            {displayName[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
      )}
      <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white max-w-[calc(100%-0.75rem)]">
        {isScreenShare ? (
          <ScreenShare className="size-3 shrink-0" />
        ) : !participant.isMicrophoneEnabled ? (
          <MicOff className="size-3 shrink-0 text-destructive" />
        ) : null}
        <span className="truncate">
          {displayName}
          {isScreenShare && " — screen"}
          {isLocal && " (you)"}
        </span>
      </div>
    </div>
  );
}

/**
 * A tile for a participant who isn't sharing any video: a large centered avatar
 * on the same dark canvas as the video tiles, with a speaking ring and a
 * name/mute footer — so the stage shows *everyone* in the call (à la Discord),
 * not just cameras.
 */
function AvatarTile({
  participant,
  isSpeaking,
}: {
  participant: Participant;
  isSpeaking: boolean;
}) {
  const pubkey = pubkeyFromLivekitIdentity(participant.identity);
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(pubkey, metadata);
  const shape = getAvatarShape(metadata);
  const hasCustomShape = !!shape;
  const isLocal = participant.isLocal;
  const muted = !participant.isMicrophoneEnabled;

  // For emoji-shaped avatars the speaking ring is a drop-shadow that hugs the
  // silhouette (a box ring would clip against the mask); circular avatars get a
  // plain ring + glow.
  const ringStyle: CSSProperties | undefined =
    hasCustomShape && isSpeaking ? { filter: shapedAvatarSpeakingStyle.filter } : undefined;

  return (
    <div className="relative flex items-center justify-center bg-black rounded-lg overflow-hidden ring-1 ring-white/10 aspect-video">
      <div
        className={cn(
          "rounded-full transition-shadow",
          !hasCustomShape && isSpeaking && "ring-2 ring-success shadow-[0_0_0_4px_hsl(var(--success)/0.35)]",
        )}
        style={ringStyle}
      >
        <Avatar shape={shape} className="size-16">
          <AvatarImage src={metadata?.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-xl">
            {displayName[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </div>
      <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white max-w-[calc(100%-0.75rem)]">
        {muted && <MicOff className="size-3 shrink-0 text-destructive" />}
        <span className="truncate">
          {displayName}
          {isLocal && " (you)"}
        </span>
      </div>
    </div>
  );
}

/**
 * The call stage: a dismissable box, shown at the top of the chat window, that
 * presents *everyone* in the call as tiles — cameras and screenshares as video,
 * audio-only participants as avatars (with a speaking ring). It animates open
 * when expanded and collapses to zero height when closed. Opening/closing is
 * driven by `open` (toggled from the corner call panel); the close button
 * collapses it via the call context.
 *
 * Rendered inside a `LiveKitRoom` context and portaled into the matching chat
 * surface's top-of-chat slot by `CallProvider`.
 */
export function CallStage({
  callLabel,
  open,
}: {
  callLabel?: React.ReactNode;
  open: boolean;
}) {
  const { setStageOpen } = useCall();
  const participants = useParticipants();
  const speakingParticipants = useSpeakingParticipants();
  const speaking = new Set(speakingParticipants.map((p) => p.identity));

  // Video tracks (camera + screenshare) we've subscribed to — each a full
  // TrackReference so `VideoTrack` has a real reference to render.
  const videoTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: true },
  ).filter((t): t is TrackReference => Boolean(t.publication));

  // Participants who already have a (camera) video tile shown; the rest get an
  // avatar tile so everyone is represented exactly once (screenshares are extra
  // tiles in addition to their owner's camera/avatar tile).
  const withCamera = new Set(
    videoTracks.filter((t) => t.source === Track.Source.Camera).map((t) => t.participant.identity),
  );
  const avatarOnly = participants.filter((p) => !withCamera.has(p.identity));

  const tileCount = videoTracks.length + avatarOnly.length;
  // Column count that keeps tiles reasonably sized as the room grows.
  const cols = tileCount <= 1 ? 1 : tileCount <= 4 ? 2 : tileCount <= 9 ? 3 : 4;

  return (
    <div
      className={cn(
        "shrink-0 mx-2 overflow-hidden transition-all duration-200 ease-out",
        open ? "mt-2 max-h-[60vh] opacity-100" : "mt-0 max-h-0 opacity-0",
      )}
    >
      <div className="clip-corner-lg bg-chrome-deep shadow-lg flex flex-col max-h-[60vh]">
        <div className="flex items-center gap-2 px-3 py-2 shrink-0">
          <span className="text-sm font-medium truncate min-w-0 flex-1">{callLabel}</span>
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {participants.length} in call
          </span>
          <button
            type="button"
            aria-label="Hide call stage"
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
            onClick={() => setStageOpen(false)}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-3 pt-0">
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {videoTracks.map((trackRef) => (
              <VideoTile
                key={`${trackRef.participant.identity}:${trackRef.source}:${trackRef.publication?.trackSid}`}
                trackRef={trackRef}
              />
            ))}
            {avatarOnly.map((p) => (
              <AvatarTile
                key={p.identity}
                participant={p}
                isSpeaking={speaking.has(p.identity)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

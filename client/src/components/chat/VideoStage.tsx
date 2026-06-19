import { useTracks, VideoTrack } from "@livekit/components-react";
import type { TrackReference } from "@livekit/components-react";
import { Track } from "livekit-client";
import { MicOff, Minimize2, ScreenShare, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { pubkeyFromLivekitIdentity } from "@/hooks/useLivekit";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { getAvatarShape } from "@/lib/avatarShape";
import { cn } from "@/lib/utils";

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
 * A full-screen overlay grid of all camera + screenshare tracks in the call.
 * It opens automatically the first time any video track appears and can be
 * minimized back to a floating "show video" pill (the call audio + control bar
 * keep running underneath). Must render inside a `LiveKitRoom` context.
 */
export function VideoStage({ callLabel }: { callLabel?: React.ReactNode }) {
  // `onlySubscribed: true` yields only tracks we've actually subscribed to; we
  // additionally require a publication so every entry is a full TrackReference
  // (never a placeholder) — `VideoTrack` needs a real reference.
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: true },
  ).filter((t): t is TrackReference => Boolean(t.publication));

  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const hadTracks = useRef(false);

  // Auto-open the stage the first time video appears (per "appearance"). Once
  // the user minimizes it, don't re-pop on every track change — only re-open
  // when video returns after having fully gone away.
  useEffect(() => {
    const has = tracks.length > 0;
    if (has && !hadTracks.current && !dismissed) {
      setOpen(true);
    }
    if (!has) {
      hadTracks.current = false;
      setDismissed(false);
      setOpen(false);
    } else {
      hadTracks.current = true;
    }
  }, [tracks.length, dismissed]);

  if (tracks.length === 0) return null;

  // Minimized: a floating pill that re-opens the stage.
  if (!open) {
    return createPortal(
      <div className="fixed bottom-20 right-3 z-50 sidebar:bottom-24">
        <Button
          variant="default"
          className="gap-2 shadow-lg"
          onClick={() => {
            setDismissed(false);
            setOpen(true);
          }}
        >
          <Video className="size-4" />
          {tracks.length} video{tracks.length === 1 ? "" : "s"}
        </Button>
      </div>,
      document.body,
    );
  }

  // Choose a grid column count that keeps tiles reasonably sized.
  const cols = tracks.length <= 1 ? 1 : tracks.length <= 4 ? 2 : tracks.length <= 9 ? 3 : 4;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm animate-in fade-in-0 duration-200">
      <div className="flex items-center gap-2 px-4 py-3 shrink-0">
        <Video className="size-4 text-success shrink-0" />
        <span className="text-sm font-medium truncate min-w-0 flex-1">{callLabel}</span>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            setOpen(false);
            setDismissed(true);
          }}
        >
          <Minimize2 className="size-3.5" />
          Minimize
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 pb-24">
        <div
          className="grid gap-3 mx-auto max-w-6xl"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {tracks.map((trackRef) => (
            <VideoTile
              key={`${trackRef.participant.identity}:${trackRef.source}:${trackRef.publication?.trackSid}`}
              trackRef={trackRef}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

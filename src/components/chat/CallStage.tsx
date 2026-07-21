import {
  useParticipants,
  useRoomContext,
  useSpeakingParticipants,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import type { TrackReference } from "@livekit/components-react";
import type { NostrMetadata } from "@nostrify/nostrify";
import type { Participant, RemoteParticipant } from "livekit-client";
import { Track } from "livekit-client";
import {
  ChevronLeft,
  ChevronRight,
  Hand,
  Maximize2,
  Minimize2,
  MicOff,
  Monitor,
  ScreenShare,
  Shrink,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CameraButton,
  LeaveButton,
  MicButton,
  RaiseHandButton,
  ReactionsMenu,
  ScreenShareButton,
} from "@/components/chat/CallControls";
import { VoiceUserContextMenu, VolumeSliderRow } from "@/components/VoiceUserContextMenu";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useUserVolume } from "@/hooks/useUserVolume";
import { useCallSignals } from "@/contexts/CallSignalsContext";
import { useVoiceIdentity } from "@/contexts/VoiceIdentityContext";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { playScreenShareSound } from "@/lib/callSounds";
import {
  getAvatarShape,
  shapedAvatarSpeakingStyle,
} from "@/lib/avatarShape";
import { cn } from "@/lib/utils";

// Back-compat re-export: the slot moved to its own (LiveKit-free) module so
// pages can render it without pulling the voice stack into their chunks.
export { CallStageSlot } from "@/components/chat/CallStageSlot";

/** The tile aspect ratio (16:9) used for fit calculations. */
const TILE_ASPECT = 16 / 9;

/**
 * Compute the grid layout (column count + per-tile pixel size) that fits all
 * `count` 16:9 tiles inside a `width`×`height` box while maximizing tile size —
 * so tiles scale down to fit instead of overflowing into a scroll. Tries every
 * column count and keeps the one yielding the largest tiles.
 */
function fitGrid(
  count: number,
  width: number,
  height: number,
  gap: number,
): { cols: number; tileW: number; tileH: number } {
  if (count <= 0 || width <= 0 || height <= 0) {
    return { cols: 1, tileW: 0, tileH: 0 };
  }
  let best = { cols: 1, tileW: 0, tileH: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    // Available space per cell after gaps.
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    // Fit a 16:9 tile inside the cell.
    let tileW = cellW;
    let tileH = tileW / TILE_ASPECT;
    if (tileH > cellH) {
      tileH = cellH;
      tileW = tileH * TILE_ASPECT;
    }
    if (tileW > best.tileW) best = { cols, tileW, tileH };
  }
  return best;
}

/**
 * Track an element's content-box size via ResizeObserver. Uses a callback ref
 * so the observer is (re)attached whenever the measured element mounts — the
 * grid container unmounts/remounts as focus/theater toggle, and a plain
 * useRef + useEffect([]) would leave a stale 0×0 size on the new element.
 */
function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observerRef.current?.disconnect();
    if (!el) {
      observerRef.current = null;
      return;
    }
    // Seed immediately so the first paint after (re)mount has real dimensions,
    // not 0×0 (the ResizeObserver callback is async).
    const rect = el.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    ro.observe(el);
    observerRef.current = ro;
  }, []);
  return [ref, size] as const;
}

/**
 * A stable key identifying a focusable tile: a participant's camera/screenshare
 * track, or an audio-only participant's avatar tile. Used to track which tile is
 * spotlighted across re-renders (track publications come and go).
 */
function trackTileKey(trackRef: TrackReference): string {
  return `${trackRef.participant.identity}:${trackRef.source}`;
}
function participantTileKey(participant: Participant): string {
  return `${participant.identity}:avatar`;
}

/** The shared look of a tile's bottom-left name pill. */
const nameplateClass =
  "absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white max-w-[calc(100%-0.75rem)]";

/** How long an unclaimed Concord identity reads as "Verifying…" before "Unverified". */
const VERIFY_GRACE_MS = 15_000;

/**
 * How long after joining a call the first video track to appear still counts
 * as "video was already rolling when I joined" and auto-expands the stage.
 * Subscriptions to pre-existing tracks land asynchronously after connecting
 * (longer on the E2EE path), so this can't just check the first render.
 */
const JOIN_VIDEO_EXPAND_WINDOW_MS = 10_000;

/**
 * How long the compact floating window keeps showing the current active
 * speaker before it's allowed to switch to a newly-loudest one. Long enough
 * that brief interjections ("mhm", a cough) and simultaneous talkers don't
 * make the single-content preview flicker between faces.
 */
const FLOATING_SPEAKER_HOLD_MS = 2_000;

/**
 * Pick the single participant/track to show in the compact floating window,
 * by priority: (1) an active screen share, (2) the manually focused tile,
 * (3) the debounced active speaker, (4) a stable first-participant fallback.
 * The chosen key indexes into the same `tiles` list the grid uses, so the
 * compact view reuses the exact tile renderer (video or avatar fallback).
 */
function usePrimaryFloatingKey(args: {
  enabled: boolean;
  focusKey: string | null;
  screenShareKey: string | null;
  speakingKey: string | null;
  fallbackKey: string | null;
}): string | null {
  const { enabled, focusKey, screenShareKey, speakingKey, fallbackKey } = args;
  // The debounced active speaker: only adopt a new speaker after the hold
  // window lapses since the last switch, so momentary/overlapping speech
  // doesn't churn the preview.
  const [heldSpeaker, setHeldSpeaker] = useState<string | null>(null);
  const lastSwitch = useRef(0);
  useEffect(() => {
    if (!enabled || !speakingKey) return;
    if (speakingKey === heldSpeaker) return;
    const now = Date.now();
    const wait = Math.max(0, FLOATING_SPEAKER_HOLD_MS - (now - lastSwitch.current));
    if (wait === 0) {
      lastSwitch.current = now;
      setHeldSpeaker(speakingKey);
      return;
    }
    const timer = setTimeout(() => {
      lastSwitch.current = Date.now();
      setHeldSpeaker(speakingKey);
    }, wait);
    return () => clearTimeout(timer);
  }, [enabled, speakingKey, heldSpeaker]);

  if (!enabled) return null;
  return screenShareKey ?? focusKey ?? heldSpeaker ?? speakingKey ?? fallbackKey;
}


/**
 * The name to render for a participant, folding in Concord's verification race
 * (CORD-07 §4): a participant's LiveKit connection and their signed presence
 * claim travel over independent channels (the SFU vs the Nostr relays), so a
 * just-joined participant is briefly unclaimed — and labeling that instant
 * "Unverified" reads as an integrity warning when nothing is wrong yet. While
 * the grace window is open the tile says "Verifying…"; only an identity that
 * stays unclaimed (or contested) past it earns "Unverified". The window is
 * anchored at the later of the participant's join and our own — a fresh viewer
 * has to rewarm its own presence fold too — so it's stable across tile
 * remounts (grid ↔ spotlight, camera on/off) and can't be reset remotely.
 */
function useTileDisplayName(participant: Participant): {
  pubkey: string;
  displayName: string;
  metadata: NostrMetadata | undefined;
} {
  const room = useRoomContext();
  const { pubkey, verified } = useVoiceIdentity()(participant.identity);
  const author = useAuthor(verified ? pubkey : undefined);
  const metadata = author.data?.metadata;
  const scopedName = useScopedDisplayName(pubkey, metadata);

  // Fallback anchor for the (transient) window before joinedAt is populated.
  const mountedAt = useRef(Date.now());
  const anchor =
    Math.max(participant.joinedAt?.getTime() ?? 0, room.localParticipant.joinedAt?.getTime() ?? 0) ||
    mountedAt.current;
  const deadline = anchor + VERIFY_GRACE_MS;
  const [, setTick] = useState(0);
  const inGrace = !verified && Date.now() < deadline;
  // Re-render when the grace window lapses so "Verifying…" flips to "Unverified".
  useEffect(() => {
    if (!inGrace) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, deadline - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [inGrace, deadline]);

  return {
    pubkey,
    displayName: verified ? scopedName : inGrace ? "Verifying…" : "Unverified",
    metadata,
  };
}

/**
 * Keep a remote participant's playback volume applied: LiveKit resets to 1 on
 * a fresh subscription, and the persisted per-pubkey volume can be changed
 * from any surface (this tile's nameplate dropdown, the tile's context menu,
 * or the sidebar roster's context menu — all via the shared `useUserVolume`
 * store). Re-applies on (re)join, identity resolution, and store changes.
 * No-ops for the local participant.
 */
function useApplyUserVolume(participant: Participant, pubkey: string) {
  const [volume] = useUserVolume(pubkey);
  useEffect(() => {
    if (!participant.isLocal) {
      // The store/UI intent is 0–1 (0–100%). Defensively clamp before handing
      // the value to LiveKit: with the default room config (webAudioMix off)
      // `setVolume` maps straight to `HTMLMediaElement.volume`, which throws
      // outside [0, 1]. This guards against stale/corrupted localStorage values
      // (e.g. a 1.5 or 2.0 persisted by an older 0–200% build).
      // TODO: real Discord-style 100–200% boost needs LiveKit `webAudioMix`
      // (a Web Audio GainNode, whose gain accepts >1) — tracked separately.
      (participant as RemoteParticipant).setVolume(Math.min(Math.max(volume, 0), 1));
    }
  }, [participant, volume, pubkey]);
}

/**
 * A dropdown anchored on a remote participant's tile nameplate with the
 * playback-volume slider, à la Discord. Shares the per-pubkey volume store
 * with the right-click menus, so all controls stay in sync.
 */
function VolumeMenu({
  pubkey,
  displayName,
  children,
}: {
  pubkey: string;
  displayName: string;
  children: React.ReactNode;
}) {
  const [volume, setVolume] = useUserVolume(pubkey);
  const pct = Math.round(volume * 100);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Volume for ${displayName}`}
          className={cn(nameplateClass, "cursor-pointer hover:bg-black/80")}
        >
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 p-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-sm font-medium truncate">{displayName}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
        </div>
        <VolumeSliderRow volume={volume} apply={setVolume} displayName={displayName} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A heavily blurred, darkened copy of the participant's avatar that fills the
 * whole tile behind the crisp centered avatar — the Signal "camera off" look.
 * When there's no picture we fall back to the plain black canvas.
 */
function BlurredAvatarBackdrop({ picture }: { picture?: string }) {
  if (!picture) return null;
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <img
        src={picture}
        alt=""
        // Scale up so the blur's soft edges never reveal the tile background,
        // then blur heavily and dim so the foreground avatar/nameplate stay legible.
        className="h-full w-full scale-150 object-cover blur-2xl"
        draggable={false}
      />
      <div className="absolute inset-0 bg-black/40" />
    </div>
  );
}

/**
 * A small amber badge pinned to a tile's top-left corner while that
 * participant's hand is raised (Armada client feature; Concord calls only). The
 * raised-hand set is surfaced on the app-level call context by the Concord room.
 */
function RaisedHandBadge({ pubkey }: { pubkey: string }) {
  const { raisedHands } = useCall();
  if (!raisedHands.has(pubkey)) return null;
  return (
    <div
      className="absolute top-1.5 left-1.5 z-10 flex items-center justify-center rounded-md bg-amber-500 text-white size-6 shadow-md animate-in fade-in-0 zoom-in-75"
      aria-label="Hand raised"
    >
      <Hand className="size-3.5" />
    </div>
  );
}

/**
 * A small deterministic horizontal jitter (−16..16px) keyed off the reaction
 * nonce, so simultaneous emoji from one participant don't stack exactly and
 * read as a little burst.
 */
function reactionOffset(nonce: string): number {
  let h = 0;
  for (let i = 0; i < nonce.length; i++) h = (h * 31 + nonce.charCodeAt(i)) | 0;
  return (h % 33) - 16;
}

/**
 * The transient emoji reactions floating up a participant's tile (à la
 * Zoom/Signal). They rise up the CENTRE of the tile — deliberately clear of the
 * bottom-left nameplate — fading and drifting on their own (~4s, matching the
 * reaction TTL), keyed by nonce so React mounts/unmounts each independently.
 */
function TileReactions({ pubkey }: { pubkey: string }) {
  const { reactions } = useCallSignals();
  const mine = reactions.filter((r) => r.author === pubkey);
  if (mine.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" aria-hidden>
      {mine.map((r) => (
        <span
          key={r.nonce}
          className="absolute bottom-[28%] left-1/2 font-emoji text-3xl leading-none animate-reaction-float drop-shadow"
          style={{ marginLeft: reactionOffset(r.nonce) }}
        >
          {r.emoji}
        </span>
      ))}
    </div>
  );
}

/** A single video tile (camera or screenshare) for one participant track. */
function VideoTile({
  trackRef,
  isSpeaking,
  focused,
  onToggleFocus,
}: {
  trackRef: TrackReference;
  isSpeaking: boolean;
  focused: boolean;
  onToggleFocus: () => void;
}) {
  const participant = trackRef.participant;
  const { pubkey, displayName, metadata } = useTileDisplayName(participant);
  const shape = getAvatarShape(metadata);
  const isScreenShare = trackRef.source === Track.Source.ScreenShare;
  // Show the avatar (not a black frame) unless there's a LIVE video track:
  // a placeholder (track not subscribed yet) OR a muted publication — turning
  // the camera/screen off mutes the track before its publication clears, and
  // rendering that produced a black tile instead of reverting to the avatar.
  const hasVideo = Boolean(trackRef.publication?.track) && !trackRef.publication?.isMuted;
  const isLocal = participant.isLocal;
  // Keep the persisted per-user volume applied to this participant's audio.
  useApplyUserVolume(participant, pubkey);
  const hasVolumeMenu = !isLocal && !isScreenShare;

  const nameplate = (
    <>
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
    </>
  );

  const tile = (
    <div
      className={cn(
        "group relative flex items-center justify-center bg-black rounded-lg overflow-hidden ring-1 ring-white/10 h-full w-full transition-shadow",
        // Active-speaker highlight, matching the avatar-tile visual language.
        // Screenshare tiles never get the participant speaking ring.
        !isScreenShare &&
          isSpeaking &&
          "ring-2 ring-success shadow-[0_0_0_4px_hsl(var(--success)/0.35)]",
      )}
    >
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef}
          // Mirror your own camera (not screenshare) so it reads naturally. The
          // video fills its (definite-height) tile and letterboxes via
          // object-contain, so a tall screenshare fits without overflowing.
          className={cn(
            "h-full w-full",
            isScreenShare || focused ? "object-contain" : "object-cover",
            isLocal && !isScreenShare && "-scale-x-100",
          )}
        />
      ) : (
        <>
          <BlurredAvatarBackdrop picture={metadata?.picture} />
          <Avatar shape={shape} className={cn("relative", focused ? "size-24" : "size-16")}>
            <AvatarImage src={metadata?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-xl">
              {displayName[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </>
      )}
      <FocusButton focused={focused} onClick={onToggleFocus} />
      {!isScreenShare && <RaisedHandBadge pubkey={pubkey} />}
      {!isScreenShare && <TileReactions pubkey={pubkey} />}
      {/* Remote (non-screenshare) nameplates open the per-user volume menu. */}
      {hasVolumeMenu ? (
        <VolumeMenu pubkey={pubkey} displayName={displayName}>
          {nameplate}
        </VolumeMenu>
      ) : (
        <div className={nameplateClass}>{nameplate}</div>
      )}
    </div>
  );

  return hasVolumeMenu ? (
    <VoiceUserContextMenu pubkey={pubkey} displayName={displayName}>
      {tile}
    </VoiceUserContextMenu>
  ) : (
    tile
  );
}

/** Hover-revealed expand/shrink button overlaid on a tile's top-right corner. */
function FocusButton({ focused, onClick }: { focused: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={focused ? "Exit focus" : "Focus this tile"}
      onClick={onClick}
      className={cn(
        "absolute top-1.5 right-1.5 rounded-md bg-black/60 p-1 text-white/90 hover:bg-black/80 hover:text-white",
        // Always visible on touch (no hover); fade in on hover for pointer devices.
        "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity [@media(hover:none)]:opacity-100",
      )}
    >
      {focused ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
    </button>
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
  focused,
  onToggleFocus,
}: {
  participant: Participant;
  isSpeaking: boolean;
  focused: boolean;
  onToggleFocus: () => void;
}) {
  const { pubkey, displayName, metadata } = useTileDisplayName(participant);
  const shape = getAvatarShape(metadata);
  const hasCustomShape = !!shape;
  const isLocal = participant.isLocal;
  const muted = !participant.isMicrophoneEnabled;
  // Keep the persisted per-user volume applied to this participant's audio.
  useApplyUserVolume(participant, pubkey);

  // For emoji-shaped avatars the speaking ring is a drop-shadow that hugs the
  // silhouette (a box ring would clip against the mask); circular avatars get a
  // plain ring + glow.
  const ringStyle: CSSProperties | undefined =
    hasCustomShape && isSpeaking ? { filter: shapedAvatarSpeakingStyle.filter } : undefined;

  const nameplate = (
    <>
      {muted && <MicOff className="size-3 shrink-0 text-destructive" />}
      <span className="truncate">
        {displayName}
        {isLocal && " (you)"}
      </span>
    </>
  );

  const tile = (
    <div
      className={cn(
        "group relative flex items-center justify-center bg-black rounded-lg overflow-hidden ring-1 ring-white/10",
        focused ? "h-full w-full" : "h-full w-full",
      )}
    >
      <BlurredAvatarBackdrop picture={metadata?.picture} />
      <div
        className={cn(
          "relative rounded-full transition-shadow",
          !hasCustomShape && isSpeaking && "ring-2 ring-success shadow-[0_0_0_4px_hsl(var(--success)/0.35)]",
        )}
        style={ringStyle}
      >
        <Avatar shape={shape} className={focused ? "size-28" : "size-16"}>
          <AvatarImage src={metadata?.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-xl">
            {displayName[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </div>
      <FocusButton focused={focused} onClick={onToggleFocus} />
      <RaisedHandBadge pubkey={pubkey} />
      <TileReactions pubkey={pubkey} />
      {/* Remote nameplates open the per-user volume menu. */}
      {!isLocal ? (
        <VolumeMenu pubkey={pubkey} displayName={displayName}>
          {nameplate}
        </VolumeMenu>
      ) : (
        <div className={nameplateClass}>{nameplate}</div>
      )}
    </div>
  );

  return !isLocal ? (
    <VoiceUserContextMenu pubkey={pubkey} displayName={displayName}>
      {tile}
    </VoiceUserContextMenu>
  ) : (
    tile
  );
}

/**
 * Compact prev/next selector shown over the floating preview when more than one
 * screen share is active, letting the viewer cycle between them (the raw track
 * order can't be trusted — it differs per client and reorders on subscribe, so
 * selection is driven by a stable, sorted key list in the parent). Also labels
 * the currently-selected sharer by display name. Rendered inside the LiveKit
 * room context, so `useTileDisplayName` resolves the sharer's name/verification.
 */
function ShareSelector({
  participant,
  index,
  total,
  onPrev,
  onNext,
}: {
  participant: Participant | null;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const name = useShareSharerName(participant);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div
      className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/70 px-1 py-0.5 text-[11px] text-white"
      // Keep any pointer/click on the selector from bubbling to the underlying
      // tile (which carries the focus toggle) or any wrapper handler.
      onPointerDown={stop}
      onClick={stop}
    >
      <button
        type="button"
        aria-label="Previous screen share"
        title="Previous screen share"
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          onPrev();
        }}
        className="rounded p-0.5 hover:bg-white/20"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="flex items-center gap-1 max-w-40 truncate">
        <ScreenShare className="size-3 shrink-0" />
        <span className="truncate">{name}</span>
        <span className="tabular-nums text-white/60">
          {index + 1}/{total}
        </span>
      </span>
      <button
        type="button"
        aria-label="Next screen share"
        title="Next screen share"
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          onNext();
        }}
        className="rounded p-0.5 hover:bg-white/20"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  );
}

/** Resolve a sharer's display name for the share selector label. */
function useShareSharerName(participant: Participant | null): string {
  const resolve = useVoiceIdentity();
  const identity = participant?.identity ?? "";
  const { pubkey, verified } = resolve(identity);
  const author = useAuthor(verified ? pubkey : undefined);
  const scopedName = useScopedDisplayName(pubkey, author.data?.metadata);
  if (!participant) return "";
  if (participant.isLocal) return "Your screen";
  return verified ? scopedName : "Screen share";
}

/**
 * The compact media controls shown inside the call stage: mute/unmute, camera
 * on/off, screen share, reactions, and leave. Used by the floating window and
 * by theater mode (where the fixed call bar is hidden behind the overlay, so
 * this is the only way to control the call). Rendered inside the LiveKit room
 * context (it's part of the reparented CallStage), so it reuses the room's
 * existing local participant + publish state via `useLocalParticipant` — no
 * duplicate media state is created. Mirrors the VoiceBar's control behavior
 * (sounds, screen-share picker/cancellation + error handling) so the two stay
 * consistent.
 */
function StageControls({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-1.5 px-2 py-1.5 shrink-0 border-t border-white/10", className)}>
      <MicButton />
      <CameraButton />
      <ScreenShareButton />
      <RaiseHandButton />
      <ReactionsMenu />
      <LeaveButton />
    </div>
  );
}

/** localStorage key + bounds for the drag-resizable docked stage height (px). */
const DOCKED_HEIGHT_KEY = "armada:call-stage:docked-height";
const DOCKED_MIN = 220;

/** The docked pane's max height: most of the viewport, leaving chat visible. */
function dockedMax(): number {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  return Math.max(DOCKED_MIN, Math.round(vh * 0.85));
}

function clampDocked(px: number): number {
  return Math.min(Math.max(px, DOCKED_MIN), dockedMax());
}

function loadDockedHeight(): number {
  try {
    const raw = localStorage.getItem(DOCKED_HEIGHT_KEY);
    const n = raw ? parseFloat(raw) : NaN;
    if (Number.isFinite(n)) return clampDocked(n);
  } catch {
    // ignore malformed/blocked storage
  }
  // Default ~42vh, matching the pane's previous fixed height.
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  return clampDocked(Math.round(vh * 0.42));
}

function saveDockedHeight(px: number): void {
  try {
    localStorage.setItem(DOCKED_HEIGHT_KEY, String(Math.round(px)));
  } catch {
    // ignore quota/private-mode failures
  }
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
  const { setStageOpen, stageFloating, floatingVariant } = useCall();
  const participants = useParticipants();
  const speakingParticipants = useSpeakingParticipants();
  const speakingIds = useMemo(
    () => new Set(speakingParticipants.map((p) => p.identity)),
    [speakingParticipants],
  );

  // Which tile is spotlighted, tracked by its stable key (or null for the grid).
  const [focusKey, setFocusKey] = useState<string | null>(null);

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

  // Auto-expand the stage when a screenshare *appears* and spotlight it (à la
  // Discord). We compare against the previous render's screenshare keys so this
  // fires only on a new share — not on every render, and not re-opening after
  // the user manually closes the stage while a share is still running.
  const screenShareKeys = videoTracks
    .filter((t) => t.source === Track.Source.ScreenShare)
    .map(trackTileKey);
  const prevScreenShareKeys = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevScreenShareKeys.current;
    const appeared = screenShareKeys.find((k) => !prev.includes(k));
    if (appeared) {
      setStageOpen(true);
      setFocusKey(appeared);
      playScreenShareSound();
    }
    prevScreenShareKeys.current = screenShareKeys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenShareKeys.join("|")]);

  // Auto-expand on join when video is already in use: if camera/screenshare
  // tracks exist when we join (their subscriptions land moments after
  // connecting), open the stage so the video is visible immediately — instead
  // of a collapsed bar whose small toggle is easy to miss. One-shot: a camera
  // turning on later must NOT reopen a stage the user closed (a *new*
  // screenshare still does, above), so the first video sighting consumes the
  // trigger whether or not it fell inside the join window.
  const mountedAt = useRef(Date.now());
  const sawVideo = useRef(false);
  const hasVideoTracks = videoTracks.length > 0;
  useEffect(() => {
    if (!hasVideoTracks || sawVideo.current) return;
    sawVideo.current = true;
    if (Date.now() - mountedAt.current <= JOIN_VIDEO_EXPAND_WINDOW_MS) setStageOpen(true);
  }, [hasVideoTracks, setStageOpen]);

  // The ordered, keyed set of focusable tiles. A render fn per tile keeps the
  // spotlight + thumbnail strip in sync without duplicating tile markup.
  const tiles = useMemo(() => {
    const list: { key: string; render: (focused: boolean) => React.ReactNode }[] = [];
    for (const trackRef of videoTracks) {
      const key = trackTileKey(trackRef);
      list.push({
        key,
        render: (focused) => (
          <VideoTile
            trackRef={trackRef}
            isSpeaking={speakingIds.has(trackRef.participant.identity)}
            focused={focused}
            onToggleFocus={() => setFocusKey((cur) => (cur === key ? null : key))}
          />
        ),
      });
    }
    for (const p of avatarOnly) {
      const key = participantTileKey(p);
      list.push({
        key,
        render: (focused) => (
          <AvatarTile
            participant={p}
            isSpeaking={speakingIds.has(p.identity)}
            focused={focused}
            onToggleFocus={() => setFocusKey((cur) => (cur === key ? null : key))}
          />
        ),
      });
    }
    return list;
    // `speakingIds`/identities change frequently; recompute is cheap.
  }, [videoTracks, avatarOnly, speakingIds]);

  // If the focused tile goes away (e.g. its owner stopped sharing or left),
  // drop back to the grid so we don't spotlight nothing.
  useEffect(() => {
    if (focusKey && !tiles.some((t) => t.key === focusKey)) setFocusKey(null);
  }, [focusKey, tiles]);

  const focused = focusKey ? tiles.find((t) => t.key === focusKey) : undefined;

  // Compact floating window: choose ONE tile to show, by priority. Screen share
  // wins; then the manually focused tile; then the debounced active speaker;
  // then a stable fallback (first video tile, else first tile) so something
  // meaningful shows even in a silent, camera-off call.
  //
  // All active screen-share tiles, in a STABLE order (by participant identity,
  // not the track array's incidental order — which flips between clients and
  // reorders on (re)subscribe). Keying the selection off this order keeps the
  // selected share from jumping when the array churns.
  const sortedShareKeys = useMemo(
    () =>
      videoTracks
        .filter((t) => t.source === Track.Source.ScreenShare)
        .map(trackTileKey)
        .sort(),
    [videoTracks],
  );
  // The selected screen share (stable across track-array reordering). One share
  // auto-selects; with several, the current pick is kept while it's still live,
  // and we fall back to the first stable one when it ends or none is chosen.
  const [selectedShareKey, setSelectedShareKey] = useState<string | null>(null);
  useEffect(() => {
    setSelectedShareKey((cur) => {
      if (sortedShareKeys.length === 0) return null;
      if (cur && sortedShareKeys.includes(cur)) return cur; // keep stable
      return sortedShareKeys[0]; // auto-select (single) or recover (ended)
    });
  }, [sortedShareKeys]);
  // Honor manual focus on a screen share: if the user focused a share tile,
  // treat that as the selection so prev/next + preview agree with the grid.
  useEffect(() => {
    if (focusKey && sortedShareKeys.includes(focusKey)) setSelectedShareKey(focusKey);
  }, [focusKey, sortedShareKeys]);
  const screenShareKey =
    selectedShareKey && sortedShareKeys.includes(selectedShareKey)
      ? selectedShareKey
      : sortedShareKeys[0] ?? null;
  const selectedShareIndex = screenShareKey ? sortedShareKeys.indexOf(screenShareKey) : -1;
  const cycleShare = useCallback(
    (dir: 1 | -1) => {
      if (sortedShareKeys.length === 0) return;
      const cur = selectedShareKey;
      const base = cur && sortedShareKeys.includes(cur) ? sortedShareKeys.indexOf(cur) : 0;
      const next = (base + dir + sortedShareKeys.length) % sortedShareKeys.length;
      const nextKey = sortedShareKeys[next];
      setSelectedShareKey(nextKey);
      // Move focus with the cycle. Otherwise the focus-honoring effect above
      // (which snaps the selection back to `focusKey` — pinned to the share
      // that auto-expanded) would immediately revert this switch: the name and
      // index would flip for a frame and then the preview would stay on the
      // previously selected share. Keeping `focusKey` in step lets the switch
      // stick. Only move focus if it was already on a share (don't create focus
      // the user didn't ask for).
      setFocusKey((f) => (f && sortedShareKeys.includes(f) ? nextKey : f));
    },
    [sortedShareKeys, selectedShareKey],
  );
  // Highest-priority current speaker that has a tile (speakingParticipants is
  // ordered loudest-first by LiveKit).
  const speakingKey = useMemo(() => {
    for (const p of speakingParticipants) {
      const cam = tiles.find((t) => t.key === `${p.identity}:${Track.Source.Camera}`);
      if (cam) return cam.key;
      const avatar = tiles.find((t) => t.key === participantTileKey(p));
      if (avatar) return avatar.key;
    }
    return null;
  }, [speakingParticipants, tiles]);
  // Stable fallback: prefer any camera tile, else the first tile.
  const fallbackKey =
    tiles.find((t) => t.key.endsWith(`:${Track.Source.Camera}`))?.key ?? tiles[0]?.key ?? null;

  const primaryKey = usePrimaryFloatingKey({
    enabled: stageFloating,
    focusKey,
    screenShareKey,
    speakingKey,
    fallbackKey,
  });
  const primaryTile =
    (primaryKey && tiles.find((t) => t.key === primaryKey)) || tiles[0] || undefined;
  // Whether the compact preview is currently showing a screen share (so the
  // floating window can render its prev/next share selector + sharer name).
  const showingShare = Boolean(screenShareKey && primaryKey === screenShareKey);
  // The selected screen share's TrackReference (resolved DIRECTLY, not via the
  // generic `tiles` list), plus the participant behind it for the name label.
  // Rendering the share from its own TrackReference — keyed by publication SID —
  // guarantees the compact <video> reattaches to the newly selected track when
  // switching, independent of how the shared `tiles`/primary-key indirection
  // reconciles.
  const selectedShareTrackRef = useMemo(
    () =>
      videoTracks.find(
        (t) => t.source === Track.Source.ScreenShare && trackTileKey(t) === screenShareKey,
      ) ?? null,
    [videoTracks, screenShareKey],
  );
  const selectedShareParticipant = selectedShareTrackRef?.participant ?? null;

  // Drag-resizable height for the docked pane (persisted). A thin handle at the
  // pane's bottom edge drives it; clamped to [DOCKED_MIN, ~85vh].
  const [dockedHeight, setDockedHeight] = useState(() => loadDockedHeight());
  const dockedResize = useRef<{ startY: number; startH: number; pointerId: number } | null>(null);
  const onDockedResizeMove = useCallback((e: PointerEvent) => {
    const a = dockedResize.current;
    if (!a || e.pointerId !== a.pointerId) return;
    setDockedHeight(clampDocked(a.startH + (e.clientY - a.startY)));
  }, []);
  const endDockedResize = useCallback(
    (e: PointerEvent) => {
      const a = dockedResize.current;
      if (!a || e.pointerId !== a.pointerId) return;
      dockedResize.current = null;
      window.removeEventListener("pointermove", onDockedResizeMove);
      window.removeEventListener("pointerup", endDockedResize);
      window.removeEventListener("pointercancel", endDockedResize);
      setDockedHeight((h) => {
        saveDockedHeight(h);
        return h;
      });
    },
    [onDockedResizeMove],
  );
  const beginDockedResize = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      dockedResize.current = { startY: e.clientY, startH: dockedHeight, pointerId: e.pointerId };
      window.addEventListener("pointermove", onDockedResizeMove);
      window.addEventListener("pointerup", endDockedResize);
      window.addEventListener("pointercancel", endDockedResize);
      e.preventDefault();
    },
    [dockedHeight, onDockedResizeMove, endDockedResize],
  );
  // Clean up global listeners if we unmount mid-resize.
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onDockedResizeMove);
      window.removeEventListener("pointerup", endDockedResize);
      window.removeEventListener("pointercancel", endDockedResize);
    },
    [onDockedResizeMove, endDockedResize],
  );

  // Theater mode: detach the stage into a full-viewport overlay.
  const [theater, setTheater] = useState(false);
  // Leaving the call / closing the stage also exits theater.
  useEffect(() => {
    if (!open) setTheater(false);
  }, [open]);
  // Esc exits theater mode.
  useEffect(() => {
    if (!theater) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTheater(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [theater]);

  // Measure the grid area so tiles scale down to fit instead of overflowing.
  const [gridRef, gridSize] = useElementSize<HTMLDivElement>();
  const GRID_GAP = 8; // matches gap-2
  const grid = fitGrid(tiles.length, gridSize.width, gridSize.height, GRID_GAP);

  const header = (
    <div
      className="flex items-center gap-2 px-3 py-2 shrink-0"
      style={
        theater
          ? { paddingTop: "calc(0.5rem + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))" }
          : undefined
      }
    >
      <span className="text-sm font-medium truncate min-w-0 flex-1">{callLabel}</span>
      {focused && (
        <button
          type="button"
          className="shrink-0 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/10"
          onClick={() => setFocusKey(null)}
        >
          <Minimize2 className="size-3.5" />
          Show all
        </button>
      )}
      <span className="text-xs text-muted-foreground tabular-nums shrink-0">
        {participants.length} in call
      </span>
      <RaiseHandButton />
      <ReactionsMenu />
      <button
        type="button"
        aria-label={theater ? "Exit theater mode" : "Theater mode"}
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
        onClick={() => setTheater((t) => !t)}
      >
        {theater ? <Shrink className="size-4" /> : <Monitor className="size-4" />}
      </button>
      <button
        type="button"
        aria-label="Hide call stage"
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
        onClick={() => setStageOpen(false)}
      >
        <X className="size-4" />
      </button>
    </div>
  );

  const body = focused ? (
    // Spotlight: the focused tile fills the available height (the panel has a
    // definite height now, so the video letterboxes via object-contain); the
    // rest go in a horizontally-scrolling thumbnail strip below.
    <div className="flex-1 min-h-0 flex flex-col gap-2 p-3 pt-0">
      <div className="flex-1 min-h-0">{focused.render(true)}</div>
      {tiles.length > 1 && (
        <div className="shrink-0 flex gap-2 overflow-x-auto">
          {tiles
            .filter((t) => t.key !== focusKey)
            .map((t) => (
              <div key={t.key} className="shrink-0 w-40 aspect-video">
                {t.render(false)}
              </div>
            ))}
        </div>
      )}
    </div>
  ) : (
    // Auto-fit grid: tiles are sized to the largest 16:9 box that fits all of
    // them in the measured area, so they scale down rather than overflowing.
    <div ref={gridRef} className="flex-1 min-h-0 overflow-hidden p-3 pt-0 flex items-center justify-center">
      <div
        className="grid place-content-center"
        style={{
          gap: GRID_GAP,
          gridTemplateColumns: `repeat(${grid.cols}, ${grid.tileW}px)`,
          gridAutoRows: `${grid.tileH}px`,
        }}
      >
        {tiles.map((t) => (
          <div key={t.key} style={{ width: grid.tileW, height: grid.tileH }}>
            {t.render(false)}
          </div>
        ))}
      </div>
    </div>
  );

  if (theater) {
    // Full-viewport overlay; the docked box collapses (renders nothing here).
    return createPortal(
      <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm animate-in fade-in-0 duration-150">
        {header}
        {body}
        {/* The fixed call bar is behind this overlay, so theater carries its own
            control row (mic/camera/screen/reactions/leave). */}
        <StageControls className="pb-[max(0.375rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]" />
      </div>,
      document.body,
    );
  }

  if (stageFloating) {
    // Compact floating destination: a SINGLE primary tile (screen share >
    // focused > active speaker > fallback, chosen above) — not the full grid.
    // Same tile renderer as the grid, so active-speaker rings, screenshare, and
    // the camera-off avatar fallback all behave identically. This is the SAME
    // stage instance as the docked one — it just re-lays-out when CallProvider
    // reparents its host into the floating destination, so no video
    // subscription is torn down or duplicated.
    //
    // Two destinations share this branch, differing only in chrome:
    //   - desktop: the draggable window supplies its header (drag/return/hide);
    //     the stage adds the media control row (mic/cam/share/leave).
    //   - mobile: the compact preview supplies its header (return/hide) and the
    //     always-present MobileCallBar carries the media controls, so the stage
    //     omits the control row here — only the primary content (and the share
    //     switcher when several shares are live) render.
    const isMobileFloating = floatingVariant === "mobile";
    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        {/* Both floating variants are width-constrained (their panels are
            resized by width), so the media area is a 16:9 box of the panel
            width — it scales with the panel and always preserves the aspect. */}
        <div className="relative w-full bg-black aspect-video">
          {showingShare && selectedShareTrackRef ? (
            // Render the SELECTED screen share directly from its own
            // TrackReference, keyed by participant identity + publication SID.
            // Switching shares changes the SID → React unmounts the old
            // VideoTile and its LiveKit <video>, and mounts a fresh one bound to
            // the newly selected publication, so the preview always shows the
            // chosen presenter (no reused/stuck element, no black frame after
            // resubscribe). Only this one compact tile re-mounts — never
            // CallStage, the room, the stage host, or unrelated subscriptions.
            <div
              key={`${selectedShareTrackRef.participant.identity}:${selectedShareTrackRef.publication?.trackSid ?? "ss"}`}
              className="h-full w-full"
            >
              <VideoTile
                trackRef={selectedShareTrackRef}
                isSpeaking={false}
                focused
                onToggleFocus={() =>
                  setFocusKey((cur) => (cur === screenShareKey ? null : screenShareKey))
                }
              />
            </div>
          ) : primaryTile ? (
            // Non-share primary content (active speaker / camera / avatar): the
            // generic tile keyed by its stable tile key still reattaches cleanly
            // on change.
            <div key={primaryTile.key} className="h-full w-full">
              {primaryTile.render(true)}
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
              Connecting…
            </div>
          )}
          {/* Multiple simultaneous screen shares: overlay a prev/next selector
              (single shares auto-select and need no switcher). */}
          {showingShare && sortedShareKeys.length > 1 && (
            <ShareSelector
              participant={selectedShareParticipant}
              index={selectedShareIndex}
              total={sortedShareKeys.length}
              onPrev={() => cycleShare(-1)}
              onNext={() => cycleShare(1)}
            />
          )}
        </div>
        {/* Media controls: only in the desktop floating window. On mobile the
            fixed MobileCallBar already carries mic/camera/screen-share/leave, so
            duplicating them here would be redundant. */}
        {!isMobileFloating && <StageControls />}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "shrink-0 mx-2 overflow-hidden ease-out",
        // Don't animate max-height while dragging the resize handle (the
        // transition would lag the pointer); animate only the open/close toggle.
        dockedResize.current ? "" : "transition-all duration-200",
        open ? "mt-2 opacity-100" : "mt-0 max-h-0 opacity-0",
      )}
      // When open, the wrapper's max-height must clear the (resizable) inner box
      // plus its top margin, or a tall pane would be clipped.
      style={open ? { maxHeight: dockedHeight + 16 } : undefined}
    >
      <div
        className="clip-corner-lg bg-chrome-deep shadow-lg flex flex-col"
        style={{ height: dockedHeight }}
      >
        {header}
        {body}
        {/* Drag the bottom edge to resize the pane taller/shorter (persisted). */}
        <div
          onPointerDown={beginDockedResize}
          role="separator"
          aria-label="Resize call pane"
          aria-orientation="horizontal"
          className="group/resize shrink-0 h-2.5 flex items-center justify-center cursor-ns-resize touch-none"
        >
          <div className="h-1 w-10 rounded-full bg-foreground/20 group-hover/resize:bg-foreground/40 transition-colors" />
        </div>
      </div>
    </div>
  );
}

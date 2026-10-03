import { DisconnectReason, ParticipantEvent, Track, type Room } from "livekit-client";

/**
 * Disconnects that end the call. Any other is a dropped connection, rejoined
 * with the same token so the identity (and peers' verification of it) is kept.
 */
const FINAL_REASONS = new Set<DisconnectReason>([
  DisconnectReason.CLIENT_INITIATED,
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.ROOM_CLOSED,
  DisconnectReason.USER_REJECTED,
  DisconnectReason.USER_UNAVAILABLE,
]);

export function isRecoverableDisconnect(reason: DisconnectReason | undefined): boolean {
  return reason === undefined || !FINAL_REASONS.has(reason);
}

const REJOIN_WINDOW_MS = 3 * 60_000;
const REJOIN_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const OFFLINE_POLL_MS = 10_000;

export interface RejoinOptions {
  signal: AbortSignal;
  micWanted: () => boolean;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  isOnline?: () => boolean;
  waitOnline?: (signal: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function waitForOnline(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve();
    const done = () => {
      window.removeEventListener("online", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    window.addEventListener("online", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Reconnects with backoff until connected (true), aborted or out of time (false). */
export async function rejoinRoom(
  room: Room,
  url: string,
  token: string,
  opts: RejoinOptions,
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const isOnline = opts.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const waitOnline = opts.waitOnline ?? waitForOnline;
  const deadline = now() + (opts.windowMs ?? REJOIN_WINDOW_MS);
  const micWanted = opts.micWanted();

  for (let attempt = 0; !opts.signal.aborted && now() < deadline; attempt++) {
    if (!isOnline()) {
      await Promise.race([waitOnline(opts.signal), sleep(OFFLINE_POLL_MS, opts.signal)]);
      continue;
    }
    try {
      await room.connect(url, token);
      if (opts.signal.aborted) return false;
      if (micWanted) {
        // After connect: LiveKitRoom's SignalConnected handler applies `audio={false}`.
        await room.localParticipant.setMicrophoneEnabled(true).catch((err) => {
          console.warn("voice: rejoined but could not republish the microphone", err);
        });
      }
      return true;
    } catch (err) {
      console.warn("voice: rejoin attempt failed", { attempt, err });
    }
    await sleep(REJOIN_BACKOFF_MS[Math.min(attempt, REJOIN_BACKOFF_MS.length - 1)], opts.signal);
  }
  return false;
}

/**
 * Whether the user wants their mic live. Unpublish is ignored: the mic button
 * mutes, and a dropping connection unpublishes while still reporting Connected.
 */
export function trackMicIntent(room: Room): { wanted: () => boolean; dispose: () => void } {
  const lp = room.localParticipant;
  let wanted = lp.isMicrophoneEnabled;
  const isMic = (pub: { source?: Track.Source }) => pub.source === Track.Source.Microphone;
  const onLive = (pub: { source?: Track.Source; isMuted?: boolean }) => {
    if (isMic(pub)) wanted = !pub.isMuted;
  };
  const onMuted = (pub: { source?: Track.Source }) => {
    if (isMic(pub)) wanted = false;
  };
  lp.on(ParticipantEvent.LocalTrackPublished, onLive)
    .on(ParticipantEvent.TrackUnmuted, onLive)
    .on(ParticipantEvent.TrackMuted, onMuted);
  return {
    wanted: () => wanted,
    dispose: () => {
      lp.off(ParticipantEvent.LocalTrackPublished, onLive)
        .off(ParticipantEvent.TrackUnmuted, onLive)
        .off(ParticipantEvent.TrackMuted, onMuted);
    },
  };
}

import { ConnectionState, RoomEvent, type Room } from "livekit-client";

/** LiveKit's `webAudioMix` context; private in its typings, replaced on every reconnect after a close. */
function contextOf(room: Room): AudioContext | undefined {
  return (room as unknown as { audioContext?: AudioContext }).audioContext;
}

const MAX_RETRY_MS = 10_000;

/**
 * Resume the call's AudioContext whenever the browser suspends it mid-call.
 * Neither the app nor LiveKit suspends it, but Chromium on Android can (seen
 * after a reconnect), and nothing resumes it: remote playback stops and the
 * RNNoise mic graph, which runs in it, sends nothing.
 */
export function keepCallAudioRunning(room: Room): () => void {
  let watched: AudioContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const check = () => {
    const ctx = contextOf(room);
    if (ctx !== watched) {
      watched?.removeEventListener("statechange", check);
      ctx?.addEventListener("statechange", check);
      watched = ctx;
    }
    clearTimeout(timer);
    if (!ctx || ctx.state !== "suspended" || room.state !== ConnectionState.Connected) {
      attempt = 0;
      return;
    }
    void ctx.resume().catch(() => {});
    // `statechange` reports success; retry in case the device isn't back yet.
    timer = setTimeout(check, Math.min(1_000 * 2 ** attempt++, MAX_RETRY_MS));
  };

  room.on(RoomEvent.Connected, check).on(RoomEvent.Reconnected, check);
  document.addEventListener("visibilitychange", check);
  window.addEventListener("pointerdown", check, true);
  check();
  return () => {
    clearTimeout(timer);
    watched?.removeEventListener("statechange", check);
    room.off(RoomEvent.Connected, check).off(RoomEvent.Reconnected, check);
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("pointerdown", check, true);
  };
}

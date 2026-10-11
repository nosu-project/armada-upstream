import { ConnectionState, LocalAudioTrack, RoomEvent, type Room } from "livekit-client";

import { liveDeviceSwitch, preferredAudioOutput } from "@/lib/voiceDevices";

/** LiveKit's `webAudioMix` context; private in its typings, replaced on every reconnect after a close. */
export function contextOf(room: Room): AudioContext | undefined {
  return (room as unknown as { audioContext?: AudioContext }).audioContext;
}

const MAX_RETRY_MS = 10_000;

/**
 * Skip LiveKit's mic silence probe where AnalyserNode can't be read (Bromite
 * strips the reads). The probe throws before `ctx.close()`, leaking a running
 * AudioContext per mic publish that keeps the audio HAL awake for as long as
 * the notification service keeps the process alive. Nothing here consumes
 * `AudioSilenceDetected`, so reporting "not silent" loses nothing.
 */
export function guardSilenceProbe(): void {
  if (typeof AnalyserNode === "undefined") return;
  if (typeof AnalyserNode.prototype.getByteTimeDomainData === "function") return;
  LocalAudioTrack.prototype.checkForSilence = () => Promise.resolve(false);
}

/**
 * Point every AudioContext LiveKit creates at the remembered speaker. Under
 * `webAudioMix` it applies `audioOutput` only to a context that already exists,
 * then creates a fresh one on connect (and after a close) on the default sink.
 * This is the only switch on (re)connect; VoiceDeviceSync owns picks made while
 * connected, so the two never race (LiveKit doesn't serialize switches).
 */
export function keepCallAudioOutput(room: Room): () => void {
  let applied: AudioContext | undefined;
  const apply = () => {
    const ctx = contextOf(room);
    if (!ctx || !("setSinkId" in ctx)) return;
    const fresh = ctx !== applied;
    applied = ctx;
    // A fresh context is on the default sink whatever getActiveDevice reports;
    // a kept one may have missed a pick made while reconnecting.
    const deviceId = fresh
      ? preferredAudioOutput()?.deviceId
      : liveDeviceSwitch("audiooutput", room.getActiveDevice("audiooutput"));
    if (deviceId) void room.switchActiveDevice("audiooutput", deviceId).catch(() => {});
  };

  room
    .on(RoomEvent.Connected, apply)
    .on(RoomEvent.Reconnected, apply)
    .on(RoomEvent.AudioPlaybackStatusChanged, apply);
  apply();
  return () => {
    room
      .off(RoomEvent.Connected, apply)
      .off(RoomEvent.Reconnected, apply)
      .off(RoomEvent.AudioPlaybackStatusChanged, apply);
  };
}

/**
 * Resume the call's AudioContext whenever the browser suspends it mid-call.
 * Neither the app nor LiveKit suspends it, but Chromium on Android can (seen
 * after a reconnect), and nothing resumes it: remote playback stops and the
 * RNNoise mic graph, which runs in it, sends nothing. WebKit reports a
 * screen lock or phone call as the non-standard `interrupted`; same remedy.
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
    const state: string | undefined = ctx?.state;
    if (!ctx || (state !== "suspended" && state !== "interrupted") || room.state !== ConnectionState.Connected) {
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

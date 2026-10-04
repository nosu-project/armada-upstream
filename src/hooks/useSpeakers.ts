import { useRoomContext, useSpeakingParticipants, useTracks } from "@livekit/components-react";
import { RoomEvent, Track, type TrackPublication } from "livekit-client";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { contextOf } from "@/lib/voiceAudioContext";

/**
 * Identities speaking now, loudest first, as measured on this device; null
 * when it can't measure (no running AudioContext), so readers fall back to
 * the SFU's active-speaker list.
 */
export const DetectedSpeakersContext = createContext<readonly string[] | null>(null);

const TICK_MS = 50;
/** RMS of the time-domain signal: on above ≈ −34 dBFS, held on down to ≈ −40. */
const ON_LEVEL = 0.02;
const OFF_LEVEL = 0.01;
/** Keeps the ring steady across the gaps between words. */
const HOLD_MS = 300;

interface Tap {
  identity: string;
  publication: TrackPublication;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  on: boolean;
  lastLoud: number;
  level: number;
}

/**
 * Client-side voice activity for every mic in the room. The SFU's
 * active-speaker updates are batched and smoothed server-side, which lights
 * rings up to a second late; reading the audio here tracks speech as heard.
 * Taps the call's own AudioContext (`webAudioMix`) rather than one per track.
 * Must render inside a `LiveKitRoom`.
 */
export function useDetectedSpeakers(): readonly string[] | null {
  const room = useRoomContext();
  const mics = useTracks([{ source: Track.Source.Microphone, withPlaceholder: false }]);
  const [speakers, setSpeakers] = useState<readonly string[] | null>(null);
  // The context is replaced on a reconnect after a close.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const bump = () => setGeneration((g) => g + 1);
    room.on(RoomEvent.Connected, bump).on(RoomEvent.Reconnected, bump);
    return () => {
      room.off(RoomEvent.Connected, bump).off(RoomEvent.Reconnected, bump);
    };
  }, [room]);

  const tracksKey = mics
    .map((t) => `${t.participant.identity}:${t.publication?.trackSid ?? ""}:${t.publication?.track?.mediaStreamTrack?.id ?? ""}`)
    .join("|");

  useEffect(() => {
    const ctx = contextOf(room);
    if (!ctx || typeof ctx.createAnalyser !== "function" || typeof MediaStream === "undefined") {
      setSpeakers(null);
      return;
    }
    const taps: Tap[] = [];
    for (const ref of mics) {
      const publication = ref.publication;
      const track = publication?.track?.mediaStreamTrack;
      if (!publication || !track) continue;
      try {
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        taps.push({
          identity: ref.participant.identity,
          publication,
          source,
          analyser,
          buffer: new Float32Array(analyser.fftSize),
          on: false,
          lastLoud: 0,
          level: 0,
        });
      } catch {
        // An unreadable track just goes unmeasured.
      }
    }

    let last: string | null = null;
    const tick = () => {
      // A suspended context reads silence, which would put every ring out.
      if (ctx.state !== "running") {
        if (last !== null) {
          last = null;
          setSpeakers(null);
        }
        return;
      }
      const now = performance.now();
      for (const tap of taps) {
        tap.analyser.getFloatTimeDomainData(tap.buffer);
        let sum = 0;
        for (const v of tap.buffer) sum += v * v;
        const rms = Math.sqrt(sum / tap.buffer.length);
        if (!tap.publication.isMuted && rms >= (tap.on ? OFF_LEVEL : ON_LEVEL)) {
          tap.on = true;
          tap.lastLoud = now;
        } else if (tap.on && (tap.publication.isMuted || now - tap.lastLoud > HOLD_MS)) {
          tap.on = false;
        }
        tap.level = tap.level * 0.7 + rms * 0.3;
      }
      const ids = [...new Set(
        taps.filter((t) => t.on).sort((a, b) => b.level - a.level).map((t) => t.identity),
      )];
      const key = ids.join("|");
      if (key !== last) {
        last = key;
        setSpeakers(ids);
      }
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(timer);
      for (const tap of taps) {
        try {
          tap.source.disconnect();
        } catch { /* ignore */ }
      }
    };
    // `tracksKey` names exactly what `mics` holds that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, tracksKey, generation]);

  return speakers;
}

/** Speaking identities, loudest first: measured here, else the SFU's. */
export function useSpeakers(): readonly string[] {
  const detected = useContext(DetectedSpeakersContext);
  const server = useSpeakingParticipants();
  return useMemo(() => detected ?? server.map((p) => p.identity), [detected, server]);
}

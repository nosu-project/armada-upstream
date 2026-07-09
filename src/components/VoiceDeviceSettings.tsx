import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Mic, MicOff, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ownAvServers } from "@/concord-v2/hooks/useVoice2";
import { probeAvBroker } from "@/concord-v2/lib/voice";
import { CONCORD_AV_SERVERS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  getPreferredMicId,
  getPreferredSpeakerId,
  getPreferredVoiceServer,
  preferredVoiceServerOrigin,
  rememberVoiceDevice,
  setPreferredVoiceServer,
} from "@/lib/voiceDevices";

/** Whether this browser can route audio output to a chosen device. */
const supportsSpeakerSelection =
  typeof document !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/** A select option for a media device, with a sensible fallback label. */
function deviceLabel(device: MediaDeviceInfo, index: number, kind: string): string {
  return device.label || `${kind} ${index + 1}`;
}

/**
 * Settings-page voice device controls: microphone + speaker pickers (outside a
 * LiveKitRoom, so they use the raw mediaDevices API rather than LiveKit's
 * room-scoped hooks), a live mic input-level meter, and a speaker test tone.
 *
 * Device choices persist via the shared `voiceDevices` helpers, so they match
 * the in-call gear menu and seed the next call's capture defaults.
 */
export function VoiceDeviceSettings() {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>(() => getPreferredMicId() ?? "default");
  const [speakerId, setSpeakerId] = useState<string>(() => getPreferredSpeakerId() ?? "default");
  const [permissionError, setPermissionError] = useState<string | null>(null);

  // Voice server (advanced): the server used to start calls in empty Concord
  // voice channels and to host DM calls. Device-local; empty = build defaults.
  const [voiceServer, setVoiceServer] = useState<string>(() => getPreferredVoiceServer());
  const queryClient = useQueryClient();
  const commitVoiceServer = useCallback(() => {
    setPreferredVoiceServer(voiceServer);
    setVoiceServer(getPreferredVoiceServer());
    // Re-run every consumer of the preference: Concord broker rendezvous, the
    // DM voice-relay pick, and our own status probe below.
    void queryClient.invalidateQueries({ queryKey: ["concord2", "av-broker"] });
    void queryClient.invalidateQueries({ queryKey: ["nip29", "dm-voice-relay"] });
    void queryClient.invalidateQueries({ queryKey: ["voice-server-status"] });
  }, [voiceServer, queryClient]);

  // Live reachability: probe the effective server list (preference first, then
  // the deployment defaults) exactly the way call setup does, so this row
  // diagnoses "voice unavailable" on any device.
  const voiceServerInvalid = Boolean(getPreferredVoiceServer()) && !preferredVoiceServerOrigin();
  const effectiveServers = ownAvServers();
  const { data: reachableServer, isFetching: checkingServer } = useQuery<string | null>({
    queryKey: ["voice-server-status", effectiveServers.join(",")],
    queryFn: async ({ signal }) => {
      for (const origin of effectiveServers) {
        if (await probeAvBroker(origin, signal)) return origin;
      }
      return null;
    },
    staleTime: 60_000,
  });

  // Mic-test state.
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0); // 0..1 input level for the meter
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  // Speaker test tone.
  const [playingTone, setPlayingTone] = useState(false);
  const toneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Enumerate devices. Labels are only populated once the page holds a media
  // permission, so we (re)enumerate after the mic test grants one and on
  // devicechange (plug/unplug).
  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setMics(list.filter((d) => d.kind === "audioinput"));
      setSpeakers(list.filter((d) => d.kind === "audiooutput"));
    } catch {
      // Enumeration unavailable — leave lists empty.
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
  }, [refreshDevices]);

  const stopMicTest = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setLevel(0);
    setTesting(false);
  }, []);

  const startMicTest = useCallback(async () => {
    setPermissionError(null);
    try {
      // Capture the chosen mic with no processing so the meter reflects the raw
      // input. Reusing the selected deviceId ties the meter to the picker.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micId && micId !== "default" ? { exact: micId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;
      // Labels become available now that we hold a grant.
      void refreshDevices();

      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        // RMS of the centered waveform → a 0..1 level, lightly scaled so normal
        // speech fills a good portion of the bar.
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setLevel(Math.min(1, rms * 3));
        rafRef.current = requestAnimationFrame(tick);
      };
      setTesting(true);
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      setPermissionError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone access denied. Allow it in your browser to test."
          : "Could not access the microphone.",
      );
      stopMicTest();
    }
  }, [micId, refreshDevices, stopMicTest]);

  // Restart the mic test when the selected device changes mid-test, so the
  // meter follows the picker.
  useEffect(() => {
    if (testing) {
      stopMicTest();
      void startMicTest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micId]);

  // Clean up on unmount.
  useEffect(
    () => () => {
      stopMicTest();
      if (toneTimerRef.current) clearTimeout(toneTimerRef.current);
    },
    [stopMicTest],
  );

  const onMicChange = (value: string) => {
    setMicId(value);
    rememberVoiceDevice("audioinput", value);
  };

  const onSpeakerChange = (value: string) => {
    setSpeakerId(value);
    rememberVoiceDevice("audiooutput", value);
  };

  // Play a short, gentle tone routed to the selected output device. We render
  // the AudioContext to a MediaStream so it can be attached to an <audio>
  // element, which is the only thing `setSinkId` can target.
  const playTestTone = useCallback(async () => {
    if (playingTone) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 440;
      // Short fade in/out to avoid a click.
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
      gain.gain.setValueAtTime(0.15, now + 0.55);
      gain.gain.linearRampToValueAtTime(0, now + 0.6);
      osc.connect(gain).connect(dest);

      const audio = new Audio();
      audio.srcObject = dest.stream;
      if (supportsSpeakerSelection && speakerId && speakerId !== "default") {
        try {
          await (audio as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(
            speakerId,
          );
        } catch {
          // Fall back to the default output.
        }
      }
      await audio.play();
      osc.start();
      setPlayingTone(true);
      osc.stop(now + 0.6);
      toneTimerRef.current = setTimeout(() => {
        audio.srcObject = null;
        void ctx.close().catch(() => {});
        setPlayingTone(false);
      }, 700);
    } catch {
      setPlayingTone(false);
    }
  }, [playingTone, speakerId]);

  return (
    <div className="space-y-5">
      {/* Microphone */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <Mic className="size-4 text-muted-foreground shrink-0" />
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Microphone
          </label>
        </div>
        <Select value={micId} onValueChange={onMicChange}>
          <SelectTrigger className="bg-background/40 border-transparent">
            <SelectValue placeholder="System default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">System default</SelectItem>
            {mics
              .filter((d) => d.deviceId && d.deviceId !== "default")
              .map((d, i) => (
                <SelectItem key={d.deviceId} value={d.deviceId}>
                  {deviceLabel(d, i, "Microphone")}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant={testing ? "secondary" : "default"}
            className="shrink-0 gap-2 clip-corner-lg w-28 justify-center"
            onClick={() => (testing ? stopMicTest() : void startMicTest())}
          >
            {testing ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            {testing ? "Stop" : "Test mic"}
          </Button>
          {/* Segmented input-level meter — neon HUD style. */}
          <div className="flex flex-1 items-center gap-0.5" aria-hidden>
            {Array.from({ length: 16 }).map((_, i) => {
              const lit = level * 16 > i;
              return (
                <div
                  key={i}
                  className={cn(
                    "h-2.5 flex-1 rounded-[1px] transition-colors duration-75",
                    lit
                      ? i > 12
                        ? "bg-destructive"
                        : "bg-success"
                      : "bg-background/60",
                  )}
                />
              );
            })}
          </div>
        </div>
        {permissionError && <p className="text-xs text-destructive">{permissionError}</p>}
        {testing && !permissionError && (
          <p className="text-xs text-muted-foreground">Speak — the meter should move.</p>
        )}
      </div>

      {/* Speaker */}
      {supportsSpeakerSelection && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <Volume2 className="size-4 text-muted-foreground shrink-0" />
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Speaker
            </label>
          </div>
          <Select value={speakerId} onValueChange={onSpeakerChange}>
            <SelectTrigger className="bg-background/40 border-transparent">
              <SelectValue placeholder="System default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">System default</SelectItem>
              {speakers
                .filter((d) => d.deviceId && d.deviceId !== "default")
                .map((d, i) => (
                  <SelectItem key={d.deviceId} value={d.deviceId}>
                    {deviceLabel(d, i, "Speaker")}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            className="gap-2 clip-corner-lg w-28 justify-center"
            disabled={playingTone}
            onClick={() => void playTestTone()}
          >
            <Volume2 className="size-4" />
            {playingTone ? "Playing…" : "Test"}
          </Button>
        </div>
      )}

      {/* Voice server (advanced). The server your client uses to START a call
          in an empty Concord voice channel and to host 1:1 DM calls; once
          anyone is in a Concord call, their announced server is the rendezvous
          point, so this only matters for cold-starting or self-hosting. */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-muted-foreground shrink-0" />
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Voice server
          </label>
        </div>
        <Input
          value={voiceServer}
          placeholder={CONCORD_AV_SERVERS[0] ?? "https://your-armada-host"}
          onChange={(e) => setVoiceServer(e.target.value)}
          onBlur={commitVoiceServer}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="bg-background/40 border-transparent"
        />
        {voiceServerInvalid ? (
          <p className="text-xs text-destructive">
            Not a usable server address — enter a host like armada.example.com (https only).
          </p>
        ) : checkingServer ? (
          <p className="text-xs text-muted-foreground">Checking voice server…</p>
        ) : reachableServer ? (
          <p className="text-xs text-success">Voice server reachable: {reachableServer}</p>
        ) : (
          <p className="text-xs text-destructive">
            No voice server reachable — calls can’t start. Check the address or your connection.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Used to start calls in empty voice channels and for direct-message calls. Leave empty
          for the default{CONCORD_AV_SERVERS[0] ? ` (${CONCORD_AV_SERVERS[0]})` : ""}.
        </p>
      </div>
    </div>
  );
}

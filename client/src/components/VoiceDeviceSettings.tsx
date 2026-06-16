import { Mic, MicOff, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getPreferredMicId,
  getPreferredSpeakerId,
  rememberVoiceDevice,
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
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">Microphone</label>
        <Select value={micId} onValueChange={onMicChange}>
          <SelectTrigger>
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
            variant="outline"
            size="sm"
            className="shrink-0 gap-2"
            onClick={() => (testing ? stopMicTest() : void startMicTest())}
          >
            {testing ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            {testing ? "Stop test" : "Test mic"}
          </Button>
          {/* Input level meter. */}
          <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-success transition-[width] duration-75"
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>
        </div>
        {permissionError && <p className="text-xs text-destructive">{permissionError}</p>}
        {testing && !permissionError && (
          <p className="text-xs text-muted-foreground">Speak — the bar should move.</p>
        )}
      </div>

      {supportsSpeakerSelection && (
        <div className="space-y-2">
          <label className="text-sm font-medium">Speaker</label>
          <Select value={speakerId} onValueChange={onSpeakerChange}>
            <SelectTrigger>
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
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={playingTone}
            onClick={() => void playTestTone()}
          >
            <Volume2 className="size-4" />
            {playingTone ? "Playing…" : "Test speaker"}
          </Button>
        </div>
      )}
    </div>
  );
}

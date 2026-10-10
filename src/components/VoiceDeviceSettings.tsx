import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Keyboard, Mic, MicOff, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ownAvServers } from "@/concord/hooks/useVoice";
import { probeAvBroker } from "@/concord/lib/voice";
import { useAppContext } from "@/hooks/useAppContext";
import {
  desktopMicAccessStatus,
  isDesktop,
  openDesktopMicSettings,
} from "@/lib/desktop";
import { CONCORD_AV_SERVERS } from "@/lib/platform";
import {
  bindingFromKeyboardEvent,
  configureDesktopPushToTalk,
  onDesktopPushToTalkStatus,
  openDesktopPushToTalkSystemSettings,
  setPushToTalkPreferences,
  usePushToTalkPreferences,
  type PushToTalkStatus,
} from "@/lib/pushToTalk";
import { cn } from "@/lib/utils";
import {
  getPreferredMicId,
  getPreferredSpeakerId,
  getPreferredVoiceServer,
  preferredVoiceServerOrigin,
  audioDeviceLabel,
  platformRoutesCallAudio,
  rememberVoiceDevice,
  setPreferredVoiceServer,
  supportsSpeakerSelection,
} from "@/lib/voiceDevices";

function deviceLabel(device: MediaDeviceInfo, index: number, kind: string): string {
  return audioDeviceLabel(device, `${kind} ${index + 1}`);
}

/**
 * Settings-page mic/speaker pickers (raw mediaDevices API; outside a
 * LiveKitRoom), mic meter and test tone. Choices persist via `voiceDevices`.
 */
export function VoiceDeviceSettings() {
  const { config, updateConfig } = useAppContext();
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>(() => getPreferredMicId() ?? "default");
  // Android picks the route itself; see platformRoutesCallAudio.
  const routeChoice = !platformRoutesCallAudio();
  const [speakerId, setSpeakerId] = useState<string>(() => getPreferredSpeakerId() ?? "default");
  const [permissionError, setPermissionError] = useState<string | null>(null);
  // OS privacy block (desktop), not our handler, so we can deep-link to OS Settings.
  const [osMicBlocked, setOsMicBlocked] = useState(false);
  const pushToTalk = usePushToTalkPreferences();
  const [recordingPushToTalk, setRecordingPushToTalk] = useState(false);
  const [pushToTalkStatus, setPushToTalkStatus] = useState<PushToTalkStatus | null>(null);
  const [checkingPushToTalk, setCheckingPushToTalk] = useState(false);
  const [openingPushToTalkSettings, setOpeningPushToTalkSettings] = useState(false);
  const [pushToTalkSettingsError, setPushToTalkSettingsError] = useState<string | null>(null);
  const pushToTalkModifierRef = useRef<ReturnType<typeof bindingFromKeyboardEvent>>(null);

  // Server for empty Concord voice channels and DM calls; empty = build defaults.
  const [voiceServer, setVoiceServer] = useState<string>(
    () => config.preferredVoiceServer || getPreferredVoiceServer(),
  );
  const queryClient = useQueryClient();
  const commitVoiceServer = useCallback(() => {
    setPreferredVoiceServer(voiceServer);
    const normalized = getPreferredVoiceServer();
    setVoiceServer(normalized);
    updateConfig((current) => ({ ...current, preferredVoiceServer: normalized }));
    void queryClient.invalidateQueries({ queryKey: ["concord", "av-broker"] });
    void queryClient.invalidateQueries({ queryKey: ["nip29", "dm-voice-relay"] });
    void queryClient.invalidateQueries({ queryKey: ["voice-server-status"] });
  }, [voiceServer, queryClient, updateConfig]);

  useEffect(() => {
    setVoiceServer(config.preferredVoiceServer);
  }, [config.preferredVoiceServer]);

  // Probe the effective server list the same way call setup does.
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

  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const [playingTone, setPlayingTone] = useState(false);
  const toneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Labels populate only with a media permission, so re-enumerate after the mic test and on devicechange.
  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setMics(list.filter((d) => d.kind === "audioinput"));
      setSpeakers(list.filter((d) => d.kind === "audiooutput"));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
  }, [refreshDevices]);

  // Warn up front on desktop if the OS blocks mic access (Windows default).
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    void desktopMicAccessStatus().then((status) => {
      if (cancelled) return;
      if (status === "denied" || status === "restricted") {
        setOsMicBlocked(true);
        setPermissionError(
          "Microphone access is turned off for apps in your system settings.",
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
    setOsMicBlocked(false);
    try {
      // Unprocessed capture so the meter reflects raw input.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micId && micId !== "default" ? { exact: micId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;
      void refreshDevices();

      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);

      // Bromite strips AnalyserNode reads.
      const readable = typeof analyser.getByteTimeDomainData === "function";
      const tick = () => {
        if (!readable) return;
        analyser.getByteTimeDomainData(data);
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
      const denied = err instanceof Error && err.name === "NotAllowedError";
      if (denied && isDesktop()) {
        const status = await desktopMicAccessStatus();
        if (status === "denied" || status === "restricted") {
          setOsMicBlocked(true);
          setPermissionError(
            "Microphone access is turned off for apps in your system settings.",
          );
          stopMicTest();
          return;
        }
      }
      setPermissionError(
        denied
          ? "Microphone access denied. Allow it in your browser to test."
          : "Could not access the microphone.",
      );
      stopMicTest();
    }
  }, [micId, refreshDevices, stopMicTest]);

  useEffect(() => {
    if (testing) {
      stopMicTest();
      void startMicTest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micId]);

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

  // `setSinkId` only targets media elements, so route the AudioContext through a MediaStream.
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
      // Fade to avoid a click.
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
      gain.gain.setValueAtTime(0.15, now + 0.55);
      gain.gain.linearRampToValueAtTime(0, now + 0.6);
      osc.connect(gain).connect(dest);

      const audio = new Audio();
      audio.srcObject = dest.stream;
      if (supportsSpeakerSelection() && speakerId && speakerId !== "default") {
        try {
          await (audio as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(
            speakerId,
          );
        } catch { /* ignore */ }
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

  // Register eagerly so failures (macOS Accessibility, Wayland without the portal) show here.
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    setCheckingPushToTalk(true);
    void configureDesktopPushToTalk(pushToTalk.enabled ? pushToTalk.binding : null).then(
      (status) => {
        if (cancelled) return;
        setPushToTalkStatus(status);
        setCheckingPushToTalk(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pushToTalk.binding, pushToTalk.enabled]);

  useEffect(() => onDesktopPushToTalkStatus((status) => {
    setPushToTalkStatus(status);
    setCheckingPushToTalk(false);
    setPushToTalkSettingsError(null);
  }), []);

  const setPushToTalkEnabled = (enabled: boolean) => {
    setPushToTalkPreferences({ ...pushToTalk, enabled });
    setPushToTalkStatus(null);
    setCheckingPushToTalk(true);
  };

  const commitPushToTalkBinding = (
    binding: NonNullable<ReturnType<typeof bindingFromKeyboardEvent>>,
  ) => {
    setPushToTalkPreferences({ enabled: pushToTalk.enabled, binding });
    setRecordingPushToTalk(false);
    pushToTalkModifierRef.current = null;
    setPushToTalkStatus(null);
    if (pushToTalk.enabled) setCheckingPushToTalk(true);
  };

  const choosePushToTalkBinding = async () => {
    if (pushToTalkStatus?.backend !== "portal" || !pushToTalkStatus.supported) {
      pushToTalkModifierRef.current = null;
      setRecordingPushToTalk(true);
      return;
    }
    if (pushToTalkStatus.settingsAvailable === false) return;
    setPushToTalkSettingsError(null);
    setOpeningPushToTalkSettings(true);
    const opened = await openDesktopPushToTalkSystemSettings();
    setOpeningPushToTalkSettings(false);
    if (!opened) {
      setPushToTalkSettingsError("Your desktop could not open its global-shortcut settings.");
    }
  };

  const recordPushToTalk = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!recordingPushToTalk) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === "Escape") {
      pushToTalkModifierRef.current = null;
      setRecordingPushToTalk(false);
      return;
    }
    const binding = bindingFromKeyboardEvent(event.nativeEvent);
    if (!binding) return;
    if (/^(Alt|Control|Meta|Shift)(Left|Right)$/.test(binding.code)) {
      // Wait for a non-modifier or this modifier's key-up (Right Ctrl alone) before committing.
      pushToTalkModifierRef.current = binding;
      return;
    }
    commitPushToTalkBinding(binding);
  };

  const finishPushToTalkModifier = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const pending = pushToTalkModifierRef.current;
    if (!recordingPushToTalk || !pending || event.code !== pending.code) return;
    event.preventDefault();
    event.stopPropagation();
    commitPushToTalkBinding(pending);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <Mic className="size-4 text-muted-foreground shrink-0" />
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Microphone
          </label>
        </div>
        {routeChoice && (
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
        )}

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
        {permissionError && (
          <div className="space-y-1.5">
            <p className="text-xs text-destructive">{permissionError}</p>
            {osMicBlocked && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 gap-2 clip-corner-lg"
                onClick={() => void openDesktopMicSettings()}
              >
                Open microphone settings
              </Button>
            )}
          </div>
        )}
        {testing && !permissionError && (
          <p className="text-xs text-muted-foreground">Speak and the meter should move.</p>
        )}
      </div>

      {routeChoice && supportsSpeakerSelection() && (
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

      {/* Per-device (localStorage): physical shortcuts shouldn't sync across machines. */}
      {isDesktop() && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <Keyboard className="size-4 text-muted-foreground shrink-0" />
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Push to talk
            </label>
            <Switch
              className="ml-auto"
              checked={pushToTalk.enabled}
              onCheckedChange={setPushToTalkEnabled}
              aria-label="Enable push to talk"
            />
          </div>
          <button
            type="button"
            onClick={() => void choosePushToTalkBinding()}
            disabled={
              pushToTalkStatus?.backend === "portal" &&
              pushToTalkStatus.supported &&
              pushToTalkStatus.settingsAvailable === false
            }
            onKeyDown={recordPushToTalk}
            onKeyUp={finishPushToTalkModifier}
            onBlur={() => {
              pushToTalkModifierRef.current = null;
              setRecordingPushToTalk(false);
            }}
            className={cn(
              "flex min-h-10 touch:min-h-11 w-full items-center justify-center clip-corner-lg px-3 text-sm font-medium transition-colors",
              recordingPushToTalk
                ? "bg-primary/10 text-primary"
                : "bg-secondary hover:bg-secondary/80 disabled:cursor-default disabled:opacity-80",
            )}
          >
            {recordingPushToTalk
              ? "Press a key or shortcut…"
              : openingPushToTalkSettings
                ? "Opening system shortcut settings…"
                : pushToTalkStatus?.backend === "portal"
                  ? pushToTalkStatus.bindingLabel || "Set system shortcut"
                  : pushToTalk.binding.label}
          </button>
          {checkingPushToTalk ? (
            <p className="text-xs text-muted-foreground">Registering global shortcut…</p>
          ) : pushToTalk.enabled && pushToTalkStatus?.supported ? (
            <p className="text-xs text-success">
              Ready globally: {pushToTalkStatus.bindingLabel || pushToTalk.binding.label}
              {pushToTalkStatus.backend === "portal" ? " (managed by your desktop)" : ""}
            </p>
          ) : pushToTalk.enabled && pushToTalkStatus?.reason ? (
            <p className="text-xs text-destructive">{pushToTalkStatus.reason}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Hold this shortcut to transmit; releasing it mutes immediately, even while Armada
              is in the background. Press Escape while recording to cancel.
            </p>
          )}
          {pushToTalkStatus?.backend === "portal" && pushToTalkStatus.supported && (
            <p className="text-xs text-muted-foreground">
              {pushToTalkStatus.settingsHint ||
                "Wayland requires your desktop's Global Shortcuts portal for push to talk."}
            </p>
          )}
          {pushToTalkSettingsError && (
            <p className="text-xs text-destructive">{pushToTalkSettingsError}</p>
          )}
        </div>
      )}

      {/* Only used where no community sets its own (Settings → Network), and for DM calls. */}
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
            Not a valid server address. Enter a host like armada.example.com (https only).
          </p>
        ) : checkingServer ? (
          <p className="text-xs text-muted-foreground">Checking voice server…</p>
        ) : reachableServer ? (
          <p className="text-xs text-success">Voice server reachable: {reachableServer}</p>
        ) : (
          <p className="text-xs text-destructive">
            No voice server reachable, so calls can’t start. Check the address or your connection.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Used for direct-message calls and for communities that set no voice servers of their
          own; a community that sets them uses only those, and this is ignored there. Leave empty
          for the default
          {CONCORD_AV_SERVERS[0] ? ` (${CONCORD_AV_SERVERS[0]})` : ""}. A custom address replaces
          the built-in Armada voice servers on every synced client.
        </p>
      </div>
    </div>
  );
}

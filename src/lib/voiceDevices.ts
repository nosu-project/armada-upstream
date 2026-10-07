/**
 * Persisted preferred voice devices. "" and "default" both mean system default
 * (no explicit preference).
 */

import { Capacitor } from "@capacitor/core";

import {
  DEFAULT_AUTO_GAIN_CONTROL,
  DEFAULT_ECHO_CANCELLATION,
  DEFAULT_NOISE_SUPPRESSION,
  DEFAULT_RNNOISE,
} from "@/lib/platform";

const MIC_KEY = "armada:voice:micDeviceId";
const SPEAKER_KEY = "armada:voice:speakerDeviceId";
const CAMERA_KEY = "armada:voice:cameraDeviceId";
const PROCESSING_KEY = "armada:voice:processing";
const VOLUME_KEY = "armada:voice:userVolumes";
const SCREEN_SHARE_VOLUME_KEY = "armada:voice:screenShareVolumes";

/** Maximum playback gain exposed by voice and screen-share volume controls. */
export const MAX_PLAYBACK_VOLUME = 2;

const VOICE_SERVER_KEY = "armada:voice:preferredServer";

function read(key: string): string | undefined {
  try {
    const v = localStorage.getItem(key);
    return v && v !== "default" ? v : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, deviceId: string): void {
  try {
    if (deviceId && deviceId !== "default") {
      localStorage.setItem(key, deviceId);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage unavailable — ignore.
  }
}

/**
 * Whether the platform picks the call's audio route itself, so the app offers
 * no mic or speaker choice. Chromium on Android lists routes as microphones;
 * picking one re-routes the whole phone, and its default follows headsets.
 */
export function platformRoutesCallAudio(): boolean {
  return Capacitor.getPlatform() === "android";
}

/**
 * The remembered preferred microphone deviceId, if any. Never on Android, where
 * a stale route pick (the earpiece) would otherwise re-route every call.
 */
export function getPreferredMicId(): string | undefined {
  return platformRoutesCallAudio() ? undefined : read(MIC_KEY);
}

/**
 * The remembered preferred speaker (audio output) deviceId, if any. Never on
 * Android, for the same reason as getPreferredMicId.
 */
export function getPreferredSpeakerId(): string | undefined {
  return platformRoutesCallAudio() ? undefined : read(SPEAKER_KEY);
}

/** The remembered preferred camera (video input) deviceId, if any. */
export function getPreferredCameraId(): string | undefined {
  return read(CAMERA_KEY);
}

/**
 * Whether the user can pick a speaker. Rooms use LiveKit `webAudioMix`, so
 * output switching needs `AudioContext.setSinkId` (Chromium 110+), not the
 * media-element one — otherwise LiveKit throws. See voicePlaybackOutput.test.ts.
 */
export function supportsSpeakerSelection(): boolean {
  if (typeof document === "undefined") return false;
  const Ctx =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Boolean(Ctx && "setSinkId" in Ctx.prototype);
}

/**
 * `RoomOptions.audioOutput` for the remembered speaker, where the app offers a
 * speaker choice at all; undefined means the system default.
 */
export function preferredAudioOutput(): { deviceId: string } | undefined {
  if (platformRoutesCallAudio() || !supportsSpeakerSelection()) return undefined;
  const deviceId = getPreferredSpeakerId();
  return deviceId ? { deviceId } : undefined;
}

/**
 * A device's display name; `fallback` for an unlabeled non-default device. The
 * unlabeled default is Chromium-on-Android's, which follows a plugged-in headset.
 */
export function audioDeviceLabel(device: MediaDeviceInfo, fallback: string): string {
  if (device.label) return device.label;
  return device.deviceId === "default" || device.deviceId === "" ? "Automatic" : fallback;
}

const deviceListeners = new Set<(kind: MediaDeviceKind) => void>();

/**
 * Subscribe to device choices, from the call bar or Settings alike, so a live
 * room can follow them. Returns an unsubscribe function.
 */
export function subscribeVoiceDevices(listener: (kind: MediaDeviceKind) => void): () => void {
  deviceListeners.add(listener);
  return () => deviceListeners.delete(listener);
}

/** Persist the user's device choice for the given kind. */
export function rememberVoiceDevice(kind: MediaDeviceKind, deviceId: string): void {
  if (kind === "audioinput") write(MIC_KEY, deviceId);
  else if (kind === "audiooutput") write(SPEAKER_KEY, deviceId);
  else if (kind === "videoinput") write(CAMERA_KEY, deviceId);
  for (const listener of deviceListeners) listener(kind);
}

/**
 * The mic or speaker a live room should switch to so it matches the remembered
 * choice ("default" when none), or undefined when `activeId` already does or
 * the platform offers no choice for `kind`.
 */
export function liveDeviceSwitch(
  kind: MediaDeviceKind,
  activeId: string | undefined,
): string | undefined {
  if (platformRoutesCallAudio()) return undefined;
  let preferred: string | undefined;
  if (kind === "audioinput") {
    preferred = getPreferredMicId();
  } else if (kind === "audiooutput") {
    if (!supportsSpeakerSelection()) return undefined;
    preferred = getPreferredSpeakerId();
  } else {
    return undefined;
  }
  const target = preferred ?? "default";
  return target === (activeId || "default") ? undefined : target;
}

/**
 * The preferred voice server as typed ("" = build defaults). A client setting
 * used for empty Concord voice channels and 1:1 DM calls; an active call's
 * presence-announced broker overrides it (CORD-07 §5).
 */
export function getPreferredVoiceServer(): string {
  try {
    const v = localStorage.getItem(VOICE_SERVER_KEY);
    return v?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Persist (or clear, with empty) the preferred voice server. */
export function setPreferredVoiceServer(value: string): void {
  try {
    const v = value.trim().replace(/\/+$/, "");
    if (v) localStorage.setItem(VOICE_SERVER_KEY, v);
    else localStorage.removeItem(VOICE_SERVER_KEY);
  } catch {
    // localStorage unavailable — ignore.
  }
}

/**
 * The preference as an https origin (accepts bare host, https, or wss). Undefined
 * if not a clean https origin — brokers take bearer credentials.
 */
export function preferredVoiceServerOrigin(): string | undefined {
  const raw = getPreferredVoiceServer();
  if (!raw) return undefined;
  let v = raw.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password) return undefined;
    return `https://${u.host.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

/** Custom AV preference as an exact replacement, or the deployment defaults. */
export function effectiveAvServers(defaults: string[]): string[] {
  const preferred = preferredVoiceServerOrigin();
  return preferred ? [preferred] : [...defaults];
}

/**
 * Mic audio-processing prefs. `rnnoise` is an ML track processor (AudioWorklet
 * + WASM) layered on the track, not a browser constraint; it stacks harmlessly
 * with `noiseSuppression`.
 */
export interface AudioProcessingPrefs {
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  rnnoise: boolean;
}

const DEFAULT_PROCESSING: AudioProcessingPrefs = {
  noiseSuppression: DEFAULT_NOISE_SUPPRESSION,
  echoCancellation: DEFAULT_ECHO_CANCELLATION,
  autoGainControl: DEFAULT_AUTO_GAIN_CONTROL,
  rnnoise: DEFAULT_RNNOISE,
};

/** The remembered audio-processing preferences (defaults: all enabled). */
export function getAudioProcessing(): AudioProcessingPrefs {
  try {
    const raw = localStorage.getItem(PROCESSING_KEY);
    if (!raw) return { ...DEFAULT_PROCESSING };
    const parsed = JSON.parse(raw) as Partial<AudioProcessingPrefs>;
    return {
      noiseSuppression: parsed.noiseSuppression ?? DEFAULT_PROCESSING.noiseSuppression,
      echoCancellation: parsed.echoCancellation ?? DEFAULT_PROCESSING.echoCancellation,
      autoGainControl: parsed.autoGainControl ?? DEFAULT_PROCESSING.autoGainControl,
      rnnoise: parsed.rnnoise ?? DEFAULT_PROCESSING.rnnoise,
    };
  } catch {
    return { ...DEFAULT_PROCESSING };
  }
}

/**
 * `audioCaptureDefaults` shared by both LiveKit room constructors so they can't
 * drift. `channelCount: 1` is load-bearing: one-channel USB interfaces would
 * otherwise play from one side only.
 */
export function micCaptureConstraints(
  processing: AudioProcessingPrefs = getAudioProcessing(),
  micId: string | null | undefined = getPreferredMicId(),
): {
  deviceId?: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  channelCount: 1;
} {
  return {
    ...(micId ? { deviceId: micId } : {}),
    noiseSuppression: processing.noiseSuppression,
    echoCancellation: processing.echoCancellation,
    autoGainControl: processing.autoGainControl,
    channelCount: 1,
  };
}

/** Persist the audio-processing preferences. */
export function setAudioProcessing(prefs: AudioProcessingPrefs): void {
  try {
    localStorage.setItem(PROCESSING_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable — ignore.
  }
}

/**
 * Per-user playback volumes by pubkey, multipliers in [0, 2] (Web Audio gain,
 * so >1 is valid); mic and screen-share stored separately, default 1 omitted.
 * Observable via `subscribeUserVolumes` so all controls and the room stay in sync.
 */
const volumeListeners = new Set<() => void>();

/** Clamp a volume multiplier to the supported [0, 2] range (NaN -> 1). */
function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(Math.max(v, 0), MAX_PLAYBACK_VOLUME);
}

/** Subscribe to per-user volume changes. Returns an unsubscribe function. */
export function subscribeUserVolumes(listener: () => void): () => void {
  volumeListeners.add(listener);
  return () => volumeListeners.delete(listener);
}

function getStoredVolumes(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getUserVolumes(): Record<string, number> {
  return getStoredVolumes(VOLUME_KEY);
}

/** Remembered mic playback volume for a pubkey (default 1). */
export function getUserVolume(pubkey: string): number {
  const v = getUserVolumes()[pubkey];
  return typeof v === "number" ? clampVolume(v) : 1;
}

/** Persist a mic playback volume; 1 clears the override. */
export function rememberUserVolume(pubkey: string, volume: number): void {
  const next = clampVolume(volume);
  try {
    const all = getUserVolumes();
    if (next === 1) delete all[pubkey];
    else all[pubkey] = next;
    localStorage.setItem(VOLUME_KEY, JSON.stringify(all));
  } catch {
    // localStorage unavailable — ignore.
  }
  for (const listener of volumeListeners) listener();
}

/** The remembered screen-share playback volume for a pubkey (defaults to 1). */
export function getScreenShareVolume(pubkey: string): number {
  const v = getStoredVolumes(SCREEN_SHARE_VOLUME_KEY)[pubkey];
  return typeof v === "number" ? clampVolume(v) : 1;
}

/** Persist a per-user screen-share playback volume independently from their mic. */
export function rememberScreenShareVolume(pubkey: string, volume: number): void {
  const next = clampVolume(volume);
  try {
    const all = getStoredVolumes(SCREEN_SHARE_VOLUME_KEY);
    if (next === 1) delete all[pubkey];
    else all[pubkey] = next;
    localStorage.setItem(SCREEN_SHARE_VOLUME_KEY, JSON.stringify(all));
  } catch {
    // localStorage unavailable — ignore.
  }
  for (const listener of volumeListeners) listener();
}

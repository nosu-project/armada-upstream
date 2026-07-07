/**
 * Persist the user's preferred voice input/output devices in localStorage so a
 * chosen mic/speaker is reused across calls and reloads. LiveKit identifies
 * devices by `deviceId`; the empty string and "default" both mean "system
 * default", which we treat as "no explicit preference".
 */

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
const VOICE_SERVER_KEY = "armada:voice:preferredServer";
/** The Concord-v1-era key for the same setting; read as a fallback. */
const LEGACY_VOICE_SERVER_KEY = "armada:voice:concordServer";

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

/** The remembered preferred microphone deviceId, if any. */
export function getPreferredMicId(): string | undefined {
  return read(MIC_KEY);
}

/** The remembered preferred speaker (audio output) deviceId, if any. */
export function getPreferredSpeakerId(): string | undefined {
  return read(SPEAKER_KEY);
}

/** The remembered preferred camera (video input) deviceId, if any. */
export function getPreferredCameraId(): string | undefined {
  return read(CAMERA_KEY);
}

/** Persist the user's device choice for the given kind. */
export function rememberVoiceDevice(kind: MediaDeviceKind, deviceId: string): void {
  if (kind === "audioinput") write(MIC_KEY, deviceId);
  else if (kind === "audiooutput") write(SPEAKER_KEY, deviceId);
  else if (kind === "videoinput") write(CAMERA_KEY, deviceId);
}

/**
 * The user's preferred voice server, raw as typed (empty = use the build-time
 * defaults). This is a CLIENT setting, not community state: it's consulted
 * ahead of the deployment defaults when starting a call in an empty Concord
 * voice channel, and when picking a LiveKit-capable relay to host a DM call.
 * Once anyone is in a Concord call, their presence-announced broker is the
 * rendezvous point and overrides this (CORD-07 §5).
 */
export function getPreferredVoiceServer(): string {
  try {
    const v = localStorage.getItem(VOICE_SERVER_KEY) ?? localStorage.getItem(LEGACY_VOICE_SERVER_KEY);
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
    localStorage.removeItem(LEGACY_VOICE_SERVER_KEY);
  } catch {
    // localStorage unavailable — ignore.
  }
}

/**
 * The preference as an https origin (the Concord AV broker form). Accepts a
 * bare host, an https origin, or a wss relay URL — they all name the same
 * Armada host. Undefined when unset or not coercible to a clean https origin
 * (brokers are bearer-credential endpoints; plaintext http is refused).
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

/** The preference as a wss relay URL (the NIP-29 DM-voice form). */
export function preferredDmVoiceRelay(): string | undefined {
  const origin = preferredVoiceServerOrigin();
  return origin ? origin.replace(/^https:\/\//, "wss://") : undefined;
}

/**
 * Browser audio-processing constraints applied to the captured mic track.
 * These map directly onto the standard MediaTrackConstraints; LiveKit defaults
 * them all to `true`, which we mirror when no preference is stored.
 *
 * `rnnoise` is different in kind: it's an ML noise-cancellation track processor
 * (AudioWorklet + WASM, BSD RNNoise) layered on top of the captured track, not
 * a browser constraint. It's far more effective at removing background noise
 * than the browser's basic `noiseSuppression`, so when it's on we leave the
 * browser `noiseSuppression` constraint alone (the two stack harmlessly).
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

/** Persist the audio-processing preferences. */
export function setAudioProcessing(prefs: AudioProcessingPrefs): void {
  try {
    localStorage.setItem(PROCESSING_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable — ignore.
  }
}

/**
 * Per-user playback volume, keyed by pubkey, as a multiplier in [0, 1]
 * (1 = unchanged, 0 = muted). Stored so a deliberately quieted user stays that
 * way across calls and reloads. Volumes equal to the default 1 are not stored,
 * keeping the map small.
 *
 * Values are clamped to [0, 1] on both read and write: LiveKit's default
 * playback path maps this straight onto `HTMLMediaElement.volume`, which only
 * accepts [0, 1]. (Real Discord-style 100–200% boost would need LiveKit
 * `webAudioMix` / a Web Audio GainNode; tracked as a separate feature.) The
 * clamp on read also sanitizes any out-of-range values persisted by an older
 * 0–200% build so they can never reach playback.
 *
 * Changes are observable (`subscribeUserVolumes`) so every surface that shows
 * a volume control — the call-stage tiles, the sidebar roster's context
 * menu — stays in sync, and the connected room can apply changes live no
 * matter where they were made.
 */
const volumeListeners = new Set<() => void>();

/** Clamp a volume multiplier to the supported [0, 1] range (NaN → 1). */
function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(Math.max(v, 0), 1);
}

/** Subscribe to per-user volume changes. Returns an unsubscribe function. */
export function subscribeUserVolumes(listener: () => void): () => void {
  volumeListeners.add(listener);
  return () => volumeListeners.delete(listener);
}

export function getUserVolumes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The remembered playback volume for a pubkey, clamped to [0, 1] (defaults to
 * 1). The clamp sanitizes stale >1 values from older builds — they read as
 * 100% rather than crashing playback.
 */
export function getUserVolume(pubkey: string): number {
  const v = getUserVolumes()[pubkey];
  return typeof v === "number" ? clampVolume(v) : 1;
}

/**
 * Persist a per-user playback volume, clamped to [0, 1]. A value of 1 clears
 * the override.
 */
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

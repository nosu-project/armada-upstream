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
} from "@/lib/platform";

const MIC_KEY = "armada:voice:micDeviceId";
const SPEAKER_KEY = "armada:voice:speakerDeviceId";
const CAMERA_KEY = "armada:voice:cameraDeviceId";
const PROCESSING_KEY = "armada:voice:processing";
const VOLUME_KEY = "armada:voice:userVolumes";

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
 * Browser audio-processing constraints applied to the captured mic track.
 * These map directly onto the standard MediaTrackConstraints; LiveKit defaults
 * them all to `true`, which we mirror when no preference is stored.
 */
export interface AudioProcessingPrefs {
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

const DEFAULT_PROCESSING: AudioProcessingPrefs = {
  noiseSuppression: DEFAULT_NOISE_SUPPRESSION,
  echoCancellation: DEFAULT_ECHO_CANCELLATION,
  autoGainControl: DEFAULT_AUTO_GAIN_CONTROL,
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
 * Per-user playback volume, keyed by pubkey, as a multiplier (1 = unchanged,
 * 0 = muted, up to 2 = boosted). Stored so a deliberately quieted/boosted user
 * stays that way across calls and reloads. Volumes equal to the default 1 are
 * not stored, keeping the map small.
 */
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

/** The remembered playback volume for a pubkey (defaults to 1). */
export function getUserVolume(pubkey: string): number {
  const v = getUserVolumes()[pubkey];
  return typeof v === "number" && v >= 0 ? v : 1;
}

/** Persist a per-user playback volume. A value of 1 clears the override. */
export function rememberUserVolume(pubkey: string, volume: number): void {
  try {
    const all = getUserVolumes();
    if (volume === 1) delete all[pubkey];
    else all[pubkey] = volume;
    localStorage.setItem(VOLUME_KEY, JSON.stringify(all));
  } catch {
    // localStorage unavailable — ignore.
  }
}

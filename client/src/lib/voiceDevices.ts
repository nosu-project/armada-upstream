/**
 * Persist the user's preferred voice input/output devices in localStorage so a
 * chosen mic/speaker is reused across calls and reloads. LiveKit identifies
 * devices by `deviceId`; the empty string and "default" both mean "system
 * default", which we treat as "no explicit preference".
 */

const MIC_KEY = "armada:voice:micDeviceId";
const SPEAKER_KEY = "armada:voice:speakerDeviceId";

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

/** Persist the user's device choice for the given kind. */
export function rememberVoiceDevice(kind: MediaDeviceKind, deviceId: string): void {
  if (kind === "audioinput") write(MIC_KEY, deviceId);
  else if (kind === "audiooutput") write(SPEAKER_KEY, deviceId);
}

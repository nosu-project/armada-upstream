export const NOTIFICATION_SOUND_SETTINGS_KEY = "armada:notification-sound";

export const NOTIFICATION_SOUNDS = [
  {
    id: "signal",
    label: "Signal",
    creator: "pedr01",
    src: "/sounds/notifications/signal.mp3",
  },
  {
    id: "pulse",
    label: "Pulse",
    creator: "deadrobotmusic",
    src: "/sounds/notifications/pulse.mp3",
  },
  {
    id: "spark",
    label: "Spark",
    creator: "AnthonyRox",
    src: "/sounds/notifications/spark.mp3",
  },
  {
    id: "low-bell",
    label: "Low bell",
    creator: "LegitCheese",
    src: "/sounds/notifications/low-bell.mp3",
  },
  {
    id: "bright-chime",
    label: "Bright chime",
    creator: "Jofae",
    src: "/sounds/notifications/bright-chime.mp3",
  },
  {
    id: "ocean",
    label: "Ocean",
    creator: "Guilherme Marçal Silva",
    src: "/sounds/notifications/ocean.mp3",
  },
] as const;

export type NotificationSoundId = (typeof NOTIFICATION_SOUNDS)[number]["id"];

export interface NotificationSoundSettings {
  enabled: boolean;
  sound: NotificationSoundId;
  volume: number;
}

export const DEFAULT_NOTIFICATION_SOUND_SETTINGS: NotificationSoundSettings = {
  enabled: false,
  sound: "signal",
  volume: 0.65,
};

const SOUND_IDS = new Set<string>(NOTIFICATION_SOUNDS.map((sound) => sound.id));
const MIN_PLAY_INTERVAL_MS = 800;

let activeAudio: HTMLAudioElement | undefined;
let lastPlayedAt = 0;

function normalizeSettings(value: unknown): NotificationSoundSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_NOTIFICATION_SOUND_SETTINGS };
  }

  const stored = value as Partial<NotificationSoundSettings>;
  const volume = typeof stored.volume === "number" && Number.isFinite(stored.volume)
    ? Math.min(1, Math.max(0, stored.volume))
    : DEFAULT_NOTIFICATION_SOUND_SETTINGS.volume;

  return {
    enabled: typeof stored.enabled === "boolean"
      ? stored.enabled
      : DEFAULT_NOTIFICATION_SOUND_SETTINGS.enabled,
    sound: typeof stored.sound === "string" && SOUND_IDS.has(stored.sound)
      ? stored.sound as NotificationSoundId
      : DEFAULT_NOTIFICATION_SOUND_SETTINGS.sound,
    volume,
  };
}

/** Read the current in-app sound preference without requiring React state. */
export function loadNotificationSoundSettings(): NotificationSoundSettings {
  try {
    const raw = localStorage.getItem(NOTIFICATION_SOUND_SETTINGS_KEY);
    return raw ? normalizeSettings(JSON.parse(raw)) : { ...DEFAULT_NOTIFICATION_SOUND_SETTINGS };
  } catch {
    return { ...DEFAULT_NOTIFICATION_SOUND_SETTINGS };
  }
}

/** Persist a normalized preference and return the value that was saved. */
export function saveNotificationSoundSettings(
  settings: NotificationSoundSettings,
): NotificationSoundSettings {
  const normalized = normalizeSettings(settings);
  try {
    localStorage.setItem(NOTIFICATION_SOUND_SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    // Storage can be unavailable in privacy modes. Keep the current session usable.
  }
  return normalized;
}

export interface PlayNotificationSoundOptions {
  /** Explicit settings are used by the preview control before state is re-read. */
  settings?: NotificationSoundSettings;
  /** Preview ignores the enabled flag and the incoming-message rate limit. */
  preview?: boolean;
}

/**
 * Play Armada's selected sound while its web UI is running.
 *
 * Browsers can reject playback until the user has interacted with the page;
 * that failure is deliberately non-fatal because the visual and OS cues still
 * remain available.
 */
export function playNotificationSound(options: PlayNotificationSoundOptions = {}): void {
  if (typeof Audio === "undefined") return;

  const settings = normalizeSettings(options.settings ?? loadNotificationSoundSettings());
  if (!settings.enabled && !options.preview) return;

  const now = Date.now();
  if (!options.preview && now - lastPlayedAt < MIN_PLAY_INTERVAL_MS) return;
  if (!options.preview) lastPlayedAt = now;

  const selected = NOTIFICATION_SOUNDS.find((sound) => sound.id === settings.sound)
    ?? NOTIFICATION_SOUNDS[0];

  try {
    activeAudio?.pause();
    const audio = new Audio(selected.src);
    audio.preload = "auto";
    audio.volume = settings.volume;
    activeAudio = audio;
    void audio.play().catch(() => undefined);
  } catch {
    // Unsupported codecs, autoplay policy and output-device failures are all
    // presentation failures; none should break notification ingest.
  }
}

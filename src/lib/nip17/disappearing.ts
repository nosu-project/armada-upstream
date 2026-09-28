/**
 * NIP-17 disappearing-message timers: a shared per-conversation duration in
 * seconds (0 = off), carried as a kind-1740 rumor (newest wins). Outgoing
 * messages carry NIP-40 `["expiration", sent_at + timer]`. Unlike Signal the
 * clock starts at SEND time, since NIP-40 only carries an absolute deadline.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export interface DisappearingPreset {
  /** Duration in seconds; 0 turns disappearing messages off. */
  seconds: number;
  label: string;
}

/** Signal's set, longest first; "Off" leads. */
export const DISAPPEARING_PRESETS: readonly DisappearingPreset[] = [
  { seconds: 0, label: "Off" },
  { seconds: 4 * WEEK, label: "4 weeks" },
  { seconds: WEEK, label: "1 week" },
  { seconds: DAY, label: "1 day" },
  { seconds: 8 * HOUR, label: "8 hours" },
  { seconds: HOUR, label: "1 hour" },
  { seconds: 5 * MINUTE, label: "5 minutes" },
  { seconds: 30, label: "30 seconds" },
];

/** Duration in words; composes units for non-preset values set by other clients. */
export function formatDisappearingDuration(seconds: number): string {
  if (seconds <= 0) return "off";
  const preset = DISAPPEARING_PRESETS.find((p) => p.seconds === seconds);
  if (preset && preset.seconds > 0) return preset.label;

  const parts: string[] = [];
  let left = Math.floor(seconds);
  for (const [unit, size] of [["week", WEEK], ["day", DAY], ["hour", HOUR], ["minute", MINUTE], ["second", 1]] as const) {
    const n = Math.floor(left / size);
    if (n > 0) parts.push(`${n} ${unit}${n === 1 ? "" : "s"}`);
    left -= n * size;
  }
  return parts.slice(0, 2).join(" ");
}

/**
 * Compact time left ("2d", "4h", "45s"), rounded UP so a visible message never
 * reads "0s". Days are the largest unit to match how timers are set.
 */
export function formatTimeLeft(expiresAt: number, nowSecs = Math.floor(Date.now() / 1000)): string {
  const left = expiresAt - nowSecs;
  if (left <= 0) return "0s";
  if (left >= DAY) return `${Math.ceil(left / DAY)}d`;
  if (left >= HOUR) return `${Math.ceil(left / HOUR)}h`;
  if (left >= MINUTE) return `${Math.ceil(left / MINUTE)}m`;
  return `${left}s`;
}

/** Timer-change notice phrased Signal-style ("You set…" / "Alice set…"). */
export function disappearingNotice(seconds: number, byMe: boolean, name: string): string {
  const who = byMe ? "You" : name;
  if (seconds <= 0) return `${who} turned off disappearing messages.`;
  return `${who} set disappearing messages to ${formatDisappearingDuration(seconds)}.`;
}

/**
 * Disappearing-messages timers for NIP-17 conversations.
 *
 * The timer is a per-conversation duration in seconds (0 = off) that both
 * participants share. It is NOT a local preference: either side may change it,
 * so it lives in the conversation itself as a kind-1740 rumor (see
 * `KIND_DM_TIMER` in `protocol.ts`) and the newest change wins. While a timer
 * is set, outgoing messages carry `["expiration", sent_at + timer]` (NIP-40).
 *
 * The deadline is absolute and starts at SEND time. Signal starts its countdown
 * when a message is read, but NIP-40 carries a single absolute timestamp with
 * no way to express a receiver-started clock — and a relay can only honor an
 * absolute one. Send-time is therefore the honest reading of the tag, and the
 * countdown shown next to a message is the real time left before every copy
 * (local, peer, relay) is dropped.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** A selectable timer duration. */
export interface DisappearingPreset {
  /** Duration in seconds; 0 turns disappearing messages off. */
  seconds: number;
  /** Menu label. */
  label: string;
}

/**
 * The offered durations, longest first (Signal's set). "Off" leads because
 * turning the feature off is the one choice a user may need in a hurry.
 */
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

/**
 * A timer duration in words ("1 day", "5 minutes", "1 week 2 days"). Falls back
 * to composing units for a duration that isn't one of the presets — a peer on
 * another client may set anything.
 */
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
  // Two units is enough to be precise without reading like a stopwatch.
  return parts.slice(0, 2).join(" ");
}

/**
 * Time left until a deadline, abbreviated for the per-message clock indicator
 * ("21d", "2d", "4h", "12m", "45s"). Rounds UP so a message never reads "0s"
 * while it is still on screen; a passed deadline reads "0s".
 *
 * Days are the largest unit: the timers are set in days ("30 days", "90 days")
 * and a countdown that answers a 30-day timer with "5w" makes the reader do
 * arithmetic to check it against the setting they chose.
 */
export function formatTimeLeft(expiresAt: number, nowSecs = Math.floor(Date.now() / 1000)): string {
  const left = expiresAt - nowSecs;
  if (left <= 0) return "0s";
  if (left >= DAY) return `${Math.ceil(left / DAY)}d`;
  if (left >= HOUR) return `${Math.ceil(left / HOUR)}h`;
  if (left >= MINUTE) return `${Math.ceil(left / MINUTE)}m`;
  return `${left}s`;
}

/**
 * The in-feed notice for a timer change, phrased from the viewer's side the
 * way Signal does ("You set…" / "Alice set…"). `name` is only used for the
 * third-person form.
 */
export function disappearingNotice(seconds: number, byMe: boolean, name: string): string {
  const who = byMe ? "You" : name;
  if (seconds <= 0) return `${who} turned off disappearing messages.`;
  return `${who} set disappearing messages to ${formatDisappearingDuration(seconds)}.`;
}

/** Format seconds to m:ss or h:mm:ss. */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Average lengths. A one- or two-character label rounds away any calendar detail. */
const MONTH = 30.44 * DAY;
const YEAR = 365.25 * DAY;

/**
 * Format a unix-seconds timestamp into a short relative string
 * ("now"/"5m"/"3h"/"2d"/"4w"/"11mo"/"2y"). Months are "mo" because "m" is minutes.
 */
export function shortTimeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d`;
  if (diff < MONTH) return `${Math.floor(diff / WEEK)}w`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}mo`;
  return `${Math.floor(diff / YEAR)}y`;
}

/** Format a unix-seconds timestamp as a long relative string ("2 days ago"). */
export function relativeTime(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000) - timestamp;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) {
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  if (days > 0) return days === 1 ? "1 day ago" : `${days} days ago`;
  if (hours > 0) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  if (minutes > 0) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  return "just now";
}

// toLocaleTimeString builds a new Intl.DateTimeFormat per call; every row calls this.
let clockFormat: Intl.DateTimeFormat | undefined;

/** Format a unix-seconds timestamp as a short local clock time ("3:07 PM"). */
export function shortClockTime(timestamp: number): string {
  clockFormat ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return clockFormat.format(new Date(timestamp * 1000));
}

let fullFormat: Intl.DateTimeFormat | undefined;

/**
 * Format a unix-seconds timestamp as a full local date and time
 * ("Sep 12, 2026, 3:07 PM") — for surfaces without day dividers, where a
 * bare clock time would leave the day unsaid.
 */
export function fullDateTime(timestamp: number): string {
  fullFormat ??= new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return fullFormat.format(new Date(timestamp * 1000));
}

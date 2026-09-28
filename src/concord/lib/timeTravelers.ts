import type { OpenedChat } from "@/concord/lib/chat";

/**
 * How far ahead of the local clock a message must be dated to be REPORTED as a
 * "time traveler" in moderation. Far coarser than {@link FUTURE_HOLD_MS} so
 * honest devices a few seconds fast aren't flagged. `created_at` is
 * unauthenticated, so this names a clock problem, never intent.
 */
export const TIME_TRAVELER_THRESHOLD_MS = 60_000;

/** One flagged author: who, how far ahead, and a sample of what they said. */
export interface TimeTraveler {
  /** The message's real author (the seal's Schnorr signer). */
  author: string;
  /** The furthest-ahead offset (ms) this author was seen at, relative to now. */
  aheadMs: number;
  /** The count of their messages dated in the future within the scanned window. */
  count: number;
  /** A short sample of the furthest-ahead message's content, for the row. */
  sample: string;
}

/**
 * Authors of messages dated more than {@link TIME_TRAVELER_THRESHOLD_MS} ahead of
 * `nowMs`, from the community's newest window (where future-dated messages sort).
 * One entry per author with their FURTHEST-ahead sighting. Caller excludes self.
 */
export function timeTravelers(
  rumorsByChannel: ReadonlyMap<string, readonly OpenedChat[]>,
  nowMs: number,
  opts: { self?: string; thresholdMs?: number } = {},
): TimeTraveler[] {
  const threshold = opts.thresholdMs ?? TIME_TRAVELER_THRESHOLD_MS;
  const ceiling = nowMs + threshold;
  const byAuthor = new Map<string, TimeTraveler>();

  for (const rumors of rumorsByChannel.values()) {
    for (const ev of rumors) {
      if (ev.ms <= ceiling) continue;
      if (opts.self && ev.author === opts.self) continue;
      const aheadMs = ev.ms - nowMs;
      const existing = byAuthor.get(ev.author);
      if (!existing) {
        byAuthor.set(ev.author, {
          author: ev.author,
          aheadMs,
          count: 1,
          sample: sampleOf(ev.content),
        });
      } else {
        existing.count += 1;
        if (aheadMs > existing.aheadMs) {
          existing.aheadMs = aheadMs;
          existing.sample = sampleOf(ev.content);
        }
      }
    }
  }

  return [...byAuthor.values()].sort((a, b) => b.aheadMs - a.aheadMs);
}

/** A one-line, length-bounded preview of a message body for the panel row. */
function sampleOf(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

/** A rounded phrase for how far ahead ("3 minutes", "2 hours"); at least "a minute". */
export function describeAhead(aheadMs: number): string {
  const secs = Math.round(aheadMs / 1000);
  if (secs < 90) return "a minute";
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/** A tongue-in-cheek "clearance level" badge scaling with how far ahead. */
export function travelerRank(aheadMs: number): string {
  const mins = aheadMs / 60_000;
  if (mins < 10) return "Slightly ahead of schedule";
  if (mins < 60) return "Chrono-drifter";
  if (mins < 24 * 60) return "Temporal tourist";
  if (mins < 7 * 24 * 60) return "Certified time traveler";
  return "Escaped the timeline";
}

import type { OpenedChat } from "@/concord/lib/chat";

/**
 * How far ahead of the local clock a message must be dated to be REPORTED as a
 * "time traveler" in the moderation panel.
 *
 * Deliberately far coarser than the timeline's {@link FUTURE_HOLD_MS} 2s grace:
 * that hold exists to keep ordinary sub-second clock jitter from stranding a
 * row, and flagging every honest device a couple of seconds fast would make the
 * panel meaningless. A minute-plus ahead is a genuinely wrong clock (or a
 * deliberately future-dated event) — worth a wink, not an accusation. The stamp
 * is the sender's own `created_at` and unauthenticated, so this NAMES a clock
 * problem, it never proves intent, and the panel copy says so.
 */
export const TIME_TRAVELER_THRESHOLD_MS = 60_000;

/** One flagged author: who, how far ahead, and a sample of what they said. */
export interface TimeTraveler {
  /** The message's real author — the seal's Schnorr signer. */
  author: string;
  /** The furthest-ahead offset (ms) this author was seen at, relative to now. */
  aheadMs: number;
  /** The count of their messages dated in the future within the scanned window. */
  count: number;
  /** A short sample of the furthest-ahead message's content, for the row. */
  sample: string;
}

/**
 * The authors of messages dated more than {@link TIME_TRAVELER_THRESHOLD_MS}
 * ahead of `nowMs`, across a community's cached rumors.
 *
 * Pure and window-bounded: it reads only the rumor sets it is handed (the
 * community's newest window, shared via `useCommunityRumors`), which is where a
 * future-dated message lives anyway — a large `created_at` sorts it to the
 * newest end. One entry per author, carrying their FURTHEST-ahead sighting so
 * the row can say "3 minutes from now" rather than a mush of offsets. Own
 * messages are excluded by the caller (a device flagging itself is just telling
 * the user their own clock is wrong, which the row's copy can't act on).
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
        // Keep the FURTHEST-ahead sighting as the representative one.
        if (aheadMs > existing.aheadMs) {
          existing.aheadMs = aheadMs;
          existing.sample = sampleOf(ev.content);
        }
      }
    }
  }

  // Furthest traveler first — the most eye-catching one leads the list.
  return [...byAuthor.values()].sort((a, b) => b.aheadMs - a.aheadMs);
}

/** A one-line, length-bounded preview of a message body for the panel row. */
function sampleOf(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

/**
 * A rounded, human phrase for how far ahead a traveler is ("3 minutes",
 * "2 hours", "5 days") — the tail of "…is sending messages from N in the
 * future". Always at least "a minute" (the threshold guarantees ≥1 min).
 */
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

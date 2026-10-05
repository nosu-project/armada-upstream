/** How long someone who stopped talking keeps their promoted spot. */
export const RECENT_SPEAKER_MS = 30_000;

export interface CallActivity {
  streaming: boolean;
  handRaised: boolean;
  /** When they were last heard (ms epoch); undefined if never. */
  lastSpokeAt?: number;
}

/**
 * Who stays on screen when a call has more people than `room`: streamers, then
 * raised hands, then the most recent speakers (within {@link RECENT_SPEAKER_MS}),
 * then join order. The result keeps the input order, so the people already
 * shown don't shuffle as the ranking moves.
 */
export function pickVisible<T>(
  people: readonly T[],
  room: number,
  activityOf: (person: T) => CallActivity,
  now: number,
): T[] {
  if (people.length <= room) return [...people];
  const recent = (a: CallActivity) =>
    a.lastSpokeAt !== undefined && now - a.lastSpokeAt <= RECENT_SPEAKER_MS ? a.lastSpokeAt : 0;
  const ranked = people
    .map((person, index) => ({ person, index, activity: activityOf(person) }))
    .sort(
      (a, b) =>
        Number(b.activity.streaming) - Number(a.activity.streaming) ||
        Number(b.activity.handRaised) - Number(a.activity.handRaised) ||
        recent(b.activity) - recent(a.activity) ||
        a.index - b.index,
    );
  const keep = new Set(ranked.slice(0, Math.max(0, room)).map((r) => r.person));
  return people.filter((person) => keep.has(person));
}

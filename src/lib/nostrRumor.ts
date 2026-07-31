import type { NostrEvent } from "@nostrify/nostrify";

/** An unsigned rumor: a NostrEvent shape with an id but no signature. */
export type NostrRumor = Omit<NostrEvent, "sig">;

/**
 * Whether a rumor still carries its signature, narrowing it to a full
 * `NostrEvent`.
 *
 * Timelines mix the two freely — relay reads are signed, local-store reads are
 * not (`db/mainEventStore.ts` drops `sig`) — and rendering does not care. This
 * is for the few places that do: anything that re-publishes an event verbatim,
 * where an unsigned copy is rejected by every relay.
 */
export function isSigned(rumor: NostrRumor): rumor is NostrEvent {
  const sig = (rumor as Partial<NostrEvent>).sig;
  return typeof sig === "string" && sig.length > 0;
}

import type { NostrEvent } from "@nostrify/nostrify";

/** An unsigned rumor: a NostrEvent shape with an id but no signature. */
export type NostrRumor = Omit<NostrEvent, "sig">;

/**
 * Narrow a rumor to a signed `NostrEvent`. Local-store reads are unsigned
 * (`db/mainEventStore.ts` drops `sig`); needed wherever an event is re-published verbatim.
 */
export function isSigned(rumor: NostrRumor): rumor is NostrEvent {
  const sig = (rumor as Partial<NostrEvent>).sig;
  return typeof sig === "string" && sig.length > 0;
}

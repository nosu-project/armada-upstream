import type { NostrEvent } from "@nostrify/nostrify";

/** An unsigned rumor: a NostrEvent shape with an id but no signature. */
export type NostrRumor = Omit<NostrEvent, "sig">;

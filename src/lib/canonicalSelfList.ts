import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import type { NostrRumor } from "@/lib/nostrRumor";

/** The version fields NIP-01 uses to resolve replaceable-event collisions. */
export type ReplaceableVersion = Pick<NostrRumor, "created_at" | "id">;

/** True when `candidate` wins the NIP-01 replaceable-event ordering. */
export function replaceableVersionIsNewer(
  candidate: ReplaceableVersion,
  current: ReplaceableVersion | undefined,
): boolean {
  return current === undefined
    || candidate.created_at > current.created_at
    || (candidate.created_at === current.created_at && candidate.id < current.id);
}

/**
 * Resolve one account-owned canonical singleton across relay and ArmadaDB
 * copies. Native background services can write a newer unsigned rumor while
 * the WebView is stopped, so the database is a first-class source rather than
 * merely a fallback for an empty relay response.
 */
export function newestCanonicalSelfList(
  events: Iterable<NostrRumor>,
  pubkey: string,
  kind: number,
): NostrRumor | undefined {
  let winner: NostrRumor | undefined;
  for (const event of events) {
    if (event.pubkey !== pubkey || event.kind !== kind) continue;
    if (replaceableVersionIsNewer(event, winner)) winner = event;
  }
  return winner;
}

export interface StoredCanonicalSelfLists {
  events: NostrRumor[];
  /** False when ArmadaDB could not be opened/read, rather than being empty. */
  available: boolean;
}

/** Best-effort read of canonical singleton rumors from ArmadaDB. */
export async function readStoredCanonicalSelfLists(
  eventStore: Promise<ArmadaEventStore>,
  pubkey: string,
  kinds: number[],
  signal?: AbortSignal,
): Promise<StoredCanonicalSelfLists> {
  try {
    const store = await eventStore;
    const events = await store.query([{ authors: [pubkey], kinds }], { signal });
    return { events, available: true };
  } catch {
    return { events: [], available: false };
  }
}

/**
 * Compare a canonical singleton with its persisted config mirror. Legacy
 * mirrors have no event id, so an equal-second winner is accepted once and
 * stamps the id; subsequent comparisons are fully deterministic.
 */
export function replaceableIsNewerThanMetadata(
  candidate: ReplaceableVersion,
  current: { updatedAt: number; eventId?: string },
): boolean {
  if (candidate.created_at !== current.updatedAt) {
    return candidate.created_at > current.updatedAt;
  }
  return current.eventId === undefined || candidate.id < current.eventId;
}

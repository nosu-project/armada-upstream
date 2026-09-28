/**
 * NIP-29 group timeline pull — the `nip29:` sync-topic handler. The wire
 * delivers live messages; this fills history outside its `since` window and
 * heals dead sockets. The scheduler decides WHEN; this module only knows HOW.
 *
 * Results are written to the relay-scoped tenant and awaited BEFORE ringing
 * the bus, so the re-read sees them (the batcher's mirror is fire-and-forget).
 * Topics are `nip29:<relayUrl>|<groupId>`; the bus scope is `nip29:<groupId>`.
 */
import { appEventStore } from "@/lib/db/mainEventStore";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { registerSyncTopic } from "@/sync/syncManager";
import { emitWireScopes } from "@/wire/bus";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Minimal relay-capable Nostr client the pull needs (batcher-backed). */
interface NostrLike {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/** NIP-88 poll kind — polls posted to the group render in the timeline. */
const KIND_POLL = 1068;

export const NIP29_TIMELINE_KINDS = [KIND_GROUP_CHAT, KIND_POLL];

/** How many messages to fetch per page (newest-page pull and each backfill). */
export const NIP29_PAGE_SIZE = 30;

export function nip29SyncTopic(relayUrl: string, groupId: string): string {
  return `nip29:${relayUrl}|${groupId}`;
}

/** Registered by the live view. */
export interface Nip29SyncContext {
  nostr: NostrLike;
}

const contexts = new Map<string, Nip29SyncContext>();

/**
 * Register the live context for a group's rounds. Returns a release; a newer
 * registration for the same topic is never clobbered by an older teardown.
 */
export function setNip29SyncContext(topic: string, ctx: Nip29SyncContext): () => void {
  contexts.set(topic, ctx);
  return () => {
    if (contexts.get(topic) === ctx) contexts.delete(topic);
  };
}

/**
 * Whether the last newest page came back full (older history likely exists).
 * Session-scoped; unknown means "assume more".
 */
const lastPullFull = new Map<string, boolean>();

export function nip29PullFull(topic: string): boolean | undefined {
  return lastPullFull.get(topic);
}

registerSyncTopic("nip29:", {
  minIntervalMs: 30_000,
  staleAfterMs: 60_000,
  handler: async ({ topic, signal }) => {
    const ctx = contexts.get(topic);
    // Context is registered before the want, so a miss is an ordering bug.
    if (!ctx) throw new Error(`no nip29 sync context for ${topic}`);
    const key = topic.slice("nip29:".length);
    const sep = key.indexOf("|");
    if (sep < 0) throw new Error(`malformed nip29 sync topic ${topic}`);
    const relayUrl = key.slice(0, sep);
    const groupId = key.slice(sep + 1);

    // A throw propagates: the scheduler marks the topic errored and retries with backoff.
    const events = await ctx.nostr.relay(relayUrl).query(
      [{ kinds: NIP29_TIMELINE_KINDS, "#h": [groupId], limit: NIP29_PAGE_SIZE }],
      { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
    );
    lastPullFull.set(topic, events.length >= NIP29_PAGE_SIZE);

    const store = await appEventStore();
    await Promise.all(
      // Per-event catch so one refused row doesn't fail the round.
      events.map((ev) => store.event(ev, { relay: relayUrl }).catch(() => undefined)),
    );
    // Ring even when nothing is new: it's how the timeline learns the round settled.
    emitWireScopes([`nip29:${groupId}`]);
  },
});

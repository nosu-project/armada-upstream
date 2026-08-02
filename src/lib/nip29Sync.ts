/**
 * NIP-29 group timeline pull — the `nip29:` sync-topic handler.
 *
 * The wire delivers LIVE messages to the store; this pull exists for history
 * the wire's `since` window never covered (first visit, deep offline gaps)
 * and to heal a dead socket. It used to run inside `useGroupMessages`'
 * queryFn behind a per-mount 30s ref — the sync scheduler now owns WHEN
 * (durable freshness stamp, min-interval, focus/online nudges); this module
 * only knows HOW.
 *
 * A round is one newest-page query against the group's relay. The results are
 * mirrored into the relay-scoped tenant HERE, awaited, before the bus rings —
 * the batcher's write-through cache mirrors them too, but fire-and-forget,
 * and a bus ring racing that write would re-read the store before the new
 * rows landed. The store de-duplicates by id, so the double write costs
 * nothing.
 *
 * Topics are `nip29:<relayUrl>|<groupId>` — the relay is part of the topic
 * (a group id means nothing without its relay; see `relayScope.ts`) — while
 * the bus scope stays `nip29:<groupId>`, matching what wire ingest emits.
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

/** Event kinds shown in a group timeline. */
export const NIP29_TIMELINE_KINDS = [KIND_GROUP_CHAT, KIND_POLL];

/** How many messages to fetch per page (newest-page pull and each backfill). */
export const NIP29_PAGE_SIZE = 30;

/** The sync-topic key for one group on one relay. */
export function nip29SyncTopic(relayUrl: string, groupId: string): string {
  return `nip29:${relayUrl}|${groupId}`;
}

/** What a round needs beyond the topic string. Registered by the live view. */
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
 * Whether the last round's newest page came back FULL — the relay likely has
 * older history past it, so the timeline's scroll-up affordance should show.
 * Session-scoped: it regenerates on the first round after launch, and an
 * unknown value just means "assume more until a `loadOlder` probe says
 * otherwise" (the pre-scheduler default).
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
    // Context is registered before the want (same hook, earlier effect), so a
    // miss is an ordering bug — fail the run rather than stamping it fresh.
    if (!ctx) throw new Error(`no nip29 sync context for ${topic}`);
    const key = topic.slice("nip29:".length);
    const sep = key.indexOf("|");
    if (sep < 0) throw new Error(`malformed nip29 sync topic ${topic}`);
    const relayUrl = key.slice(0, sep);
    const groupId = key.slice(sep + 1);

    // A throw here (timeout, dead socket) propagates: the scheduler marks the
    // topic error and retries with backoff, and the timeline's skeleton gate
    // releases to the empty state exactly as the old pull's `finally` did.
    const events = await ctx.nostr.relay(relayUrl).query(
      [{ kinds: NIP29_TIMELINE_KINDS, "#h": [groupId], limit: NIP29_PAGE_SIZE }],
      { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
    );
    lastPullFull.set(topic, events.length >= NIP29_PAGE_SIZE);

    const store = await appEventStore();
    await Promise.all(
      // Filed under the serving relay (the relay-scoped tenant); per-event
      // catch so one duplicate/refused row doesn't fail the round.
      events.map((ev) => store.event(ev, { relay: relayUrl }).catch(() => undefined)),
    );
    // Ring even when nothing new landed: the re-read is cheap, and it is how
    // the timeline learns the round settled (fresh `hasMore`, released gates).
    emitWireScopes([`nip29:${groupId}`]);
  },
});

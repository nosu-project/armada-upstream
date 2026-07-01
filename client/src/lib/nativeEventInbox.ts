/**
 * Session inbox of raw events received from the NATIVE background service
 * (NotificationRelayService → ArmadaNotificationPlugin → useNativeEventFeed).
 *
 * Why this exists: on a cold launch from a notification tap, the drain of
 * natively-buffered events RACES the channel hooks' mounts. The old path only
 * inserted drained events into query-cache entries that already existed — if
 * the drain won the race (the common case: it runs on the first mount, before
 * the deep-linked channel's query has run), the tapped message went only to
 * IndexedDB, behind the same multi-second cold-open the queryFn was about to
 * wait on. The message you tapped painted LAST.
 *
 * This inbox keeps every natively-fed event of the session in a small bounded
 * ring that timeline queryFns read SYNCHRONOUSLY and merge into their
 * local-first result (all merges dedupe by id, so double-delivery is free).
 * Order of drain vs. mount no longer matters.
 *
 * Memory: capped at {@link MAX_EVENTS} wire events (~a few hundred KB max).
 * Cleared implicitly on reload; never persisted (IndexedDB owns durability).
 */

import type { NostrEvent } from "@nostrify/nostrify";

const MAX_EVENTS = 300;

/** NIP-29 timeline kinds the group timeline renders directly. */
const NIP29_TIMELINE_KINDS = new Set<number>([9, 1068]);
/** NIP-04 direct message kind. */
const KIND_DM = 4;

const ring: NostrEvent[] = [];
const seen = new Set<string>();

/** Record a raw event fed by the native service (live emit or drain). */
export function recordNativeEvent(ev: NostrEvent): void {
  if (seen.has(ev.id)) return;
  seen.add(ev.id);
  ring.push(ev);
  while (ring.length > MAX_EVENTS) {
    const dropped = ring.shift();
    if (dropped) seen.delete(dropped.id);
  }
}

/** First value of an event's `#h` (group id) tag, if any. */
function groupIdOf(ev: NostrEvent): string | undefined {
  for (const tag of ev.tags) if (tag[0] === "h" && tag[1]) return tag[1];
  return undefined;
}

/**
 * Natively-received timeline events (kind 9/1068) for a NIP-29 group,
 * oldest-first. Merged by useGroupMessages' queryFn.
 */
export function nativeGroupTimelineEvents(groupId: string): NostrEvent[] {
  return ring
    .filter((ev) => NIP29_TIMELINE_KINDS.has(ev.kind) && groupIdOf(ev) === groupId)
    .sort((a, b) => a.created_at - b.created_at);
}

/**
 * Natively-received kind-4 DMs, oldest-first. Merged by the DM conversation
 * list and (peer-filtered by the caller) the DM thread queryFns.
 */
export function nativeDmEvents(): NostrEvent[] {
  return ring.filter((ev) => ev.kind === KIND_DM).sort((a, b) => a.created_at - b.created_at);
}

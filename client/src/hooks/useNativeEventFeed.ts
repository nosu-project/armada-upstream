import { App as CapacitorApp } from "@capacitor/app";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { parkPendingWraps } from "@/concord-v2/lib/rumorStore";
import { recordNativeEvent } from "@/lib/nativeEventInbox";
import { ArmadaNotification } from "@/lib/nativeNotifications";
import { recordTimelineEvent, recordUnreadActivity } from "@/lib/nip29Activity";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-29 group chat / poll kinds — plaintext, renderable as-is. */
const KIND_GROUP_CHAT = 9;
const KIND_POLL = 1068;

/** NIP-29 kinds whose wire event the timeline can render directly. */
const NIP29_TIMELINE_KINDS = new Set<number>([KIND_GROUP_CHAT, KIND_POLL]);

/**
 * Feed raw outer events the native background service already received straight
 * into the WebView so a message a notification was about is on screen the
 * instant the app opens — no relay round-trip, no "wait for the chat to catch
 * up". The service decrypted/rendered it for the notification; the WebView just
 * needs the same wire event.
 *
 * This makes the native service the FAST PRIMARY transport on Android (the
 * webview's own live `req` in useGroupMessages/useConcordChannel stays as a
 * healing backstop + the 60s poll). Two delivery paths, both ingesting the same
 * raw events:
 *   - live: the service emits `relayEvent` while the WebView is up;
 *   - drain: on mount / resume, pull events buffered while the WebView was down.
 *
 * Ingest splits by what the WebView can do with the event:
 *
 *   - NIP-29 plaintext (kind 9/1068): inserted DIRECTLY into the matching
 *     `["nip29","messages",…]` query cache, exactly like the live subscription's
 *     `upsertMessage` — so it renders immediately, with no debounce and no
 *     invalidate→refetch round-trip. This is the Vector-style "push the
 *     already-received struct straight into the array" path. (Kind 5 deletions
 *     are also persisted so a re-read honors them; applying a live delete is
 *     left to the channel hook's own subscription to keep this hook simple.)
 *
 *   - Concord sealed (kind 3300 V1 outers, kind 1059 V2 wraps): the WebView
 *     can't decode without the epoch/stream keys the channel hooks hold, so
 *     they're written to the store (below); the V2 channel's store-first read
 *     and the V1 `concordMessage` feed surface them when the room opens.
 *
 * Everything is also written to the shared IndexedDB store so a later cold read
 * (channel switch / refetch) still finds it.
 */
export function useNativeEventFeed(): void {
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isNativeRuntime()) return;
    let cancelled = false;

    /**
     * Insert a plaintext NIP-29 timeline event directly into every cached
     * `["nip29","messages",relayUrl,groupId]` entry for its group, and fan it
     * into the `["nip29","unread",…]` badge caches — a natively-delivered
     * message must light the channel badge, not just render in the timeline.
     * No-op on the timeline side if the group isn't open (no cache entry) —
     * the store write below still keeps it for when it is.
     */
    const insertNip29 = (ev: NostrEvent): void => {
      recordTimelineEvent(queryClient, ev);
      recordUnreadActivity(queryClient, [ev]);
    };

    /** Ingest a batch of raw outer events: render first, persist after. */
    const ingest = async (raw: string[]) => {
      if (raw.length === 0) return;

      // Parse the batch up front so the render path is synchronous and never
      // waits on a single malformed line.
      const events: NostrEvent[] = [];
      for (const json of raw) {
        try {
          const ev = JSON.parse(json) as NostrEvent;
          if (ev && typeof ev.id === "string" && typeof ev.kind === "number") {
            events.push(ev);
          }
        } catch {
          // malformed line — skip
        }
      }
      if (events.length === 0 || cancelled) return;

      // RENDER FIRST — synchronously surface plaintext NIP-29 messages BEFORE the
      // (comparatively slow) IndexedDB write. On a cold launch from a
      // notification the room's queryFn is racing this: it reads IndexedDB
      // local-first and folds in whatever's already in the cache, so getting the
      // fed event into the cache *now* (not after the await) is what makes the
      // notification's message appear on the first paint instead of a beat later.
      //
      // Every event is ALSO recorded into the session inbox
      // (nativeEventInbox), which the timeline queryFns merge synchronously —
      // that covers the other side of the race, where this drain runs BEFORE
      // the deep-linked channel's query cache entry exists (the cache insert
      // below would be a no-op) and the IndexedDB write hasn't landed yet.
      //
      // Concord (kind 3300) is NOT handled here: its messages render via the
      // service-decrypted `concordMessage` feed (see useConcordChannel), which is
      // instant AND signature-verified. We still PERSIST the sealed outer below
      // so a later cold read / backfill reconciles against it.
      for (const ev of events) {
        recordNativeEvent(ev);
        if (NIP29_TIMELINE_KINDS.has(ev.kind)) {
          insertNip29(ev); // plaintext → direct cache insert, instant
        }
      }

      // PERSIST AFTER — write every event to the shared store so a later cold
      // read (channel switch / refetch) still finds it. EXCEPT Concord V2 wraps
      // (kind 1059/21059): those never touch `armada-events` — the service can't
      // decrypt them, so they're parked in the pending store for the WebView's
      // plane hooks (which hold the keys) to drain, decrypt, and move into the
      // opened-event store.
      const v2Wraps = events.filter((ev) => ev.kind === 1059 || ev.kind === 21059);
      if (v2Wraps.length > 0) parkPendingWraps(v2Wraps);

      const store = await eventStore;
      for (const ev of events) {
        if (ev.kind === 1059 || ev.kind === 21059) continue;
        try {
          await store.event(ev);
        } catch {
          // store write failed — the NIP-29 cache insert above still rendered it
        }
      }
    };

    // Drain anything buffered while the WebView was down (open / resume).
    const drain = () => {
      ArmadaNotification.drainEvents()
        .then(({ events }) => ingest(events))
        .catch(() => undefined);
    };
    drain();

    // The live `relayEvent` stops firing while the app is backgrounded (the
    // WebView is paused), so events buffer natively — drain them on resume.
    let resumeHandle: { remove: () => void } | undefined;
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) drain();
    })
      .then((h) => {
        if (cancelled) h.remove();
        else resumeHandle = h;
      })
      .catch(() => undefined);

    // Live feed while the app is open.
    let handle: { remove: () => void } | undefined;
    ArmadaNotification.addListener("relayEvent", ({ event }) => {
      void ingest([event]);
    })
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      handle?.remove();
      resumeHandle?.remove();
    };
  }, [eventStore, queryClient]);
}

import { App as CapacitorApp } from "@capacitor/app";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { ArmadaNotification } from "@/lib/nativeNotifications";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Feed raw outer events the native background service already received straight
 * into the WebView's event store, so a message a notification was about is on
 * screen the instant the app opens — no relay round-trip, no "wait for the chat
 * to catch up". The service decrypted/rendered it for the notification; the
 * WebView just needs the same wire event in its store.
 *
 * Two paths, both writing the raw event to the shared IndexedDB store:
 *   - live: the service emits `relayEvent` while the WebView is up;
 *   - drain: on mount / resume, pull events buffered while the WebView was down.
 *
 * After writing, we invalidate the chat-timeline queries so their store-backed
 * read recomposes (cheap: decode is memoized). NIP-29 kind-9/etc. are plaintext;
 * Concord kind-3300 are sealed and decoded by the channel read path under the
 * held epoch keys — same as any blob the relay backfill would have delivered.
 */
export function useNativeEventFeed(): void {
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isNativeRuntime()) return;
    let cancelled = false;

    // The fed event is already in the durable store. Nudge the chat timelines to
    // recompose from it. Refetch only ACTIVE queries (the open channel), and
    // debounce so a burst of fed events causes one refetch — not one per event.
    // `keepPreviousData` keeps the current messages on screen during the refetch,
    // so an already-loaded channel updates without flashing a skeleton.
    let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
    const nudgeTimelines = () => {
      if (nudgeTimer !== undefined) return;
      nudgeTimer = setTimeout(() => {
        nudgeTimer = undefined;
        if (cancelled) return;
        void queryClient.invalidateQueries({ queryKey: ["concord", "channel"], refetchType: "active" });
        void queryClient.invalidateQueries({ queryKey: ["nip29", "messages"], refetchType: "active" });
      }, 400);
    };

    /** Write a batch of raw outer events to the store, then nudge the timelines. */
    const ingest = async (raw: string[]) => {
      if (raw.length === 0) return;
      const store = await eventStore;
      let wrote = false;
      for (const json of raw) {
        try {
          const ev = JSON.parse(json) as NostrEvent;
          if (!ev || typeof ev.id !== "string" || typeof ev.kind !== "number") continue;
          await store.event(ev);
          wrote = true;
        } catch {
          // Malformed line — skip it.
        }
      }
      if (!wrote || cancelled) return;
      // Recompose the chat timelines from the (now-updated) store. Targeted to
      // the two chat query families so unrelated queries aren't touched.
      nudgeTimelines();
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
      if (nudgeTimer !== undefined) clearTimeout(nudgeTimer);
      handle?.remove();
      resumeHandle?.remove();
    };
  }, [eventStore, queryClient]);
}

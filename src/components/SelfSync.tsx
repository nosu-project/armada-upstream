import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  KIND_APP_SPECIFIC,
  queryKeysForSelfEvent,
  SELF_SYNC_DTAGS,
  SELF_SYNC_REPLACEABLE_KINDS,
} from "@/lib/selfSyncKinds";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * Overlap window applied to the standing REQ's `since` on (re)subscribe: a
 * short look-back so a replaceable published while we were briefly offline is
 * caught. Replaceables are latest-wins, so we don't need a persisted cursor —
 * we just want the newest version, and the store dedupes by id anyway.
 */
const LOOKBACK_SECONDS = 5 * 60;

/** Coalescing window (ms) for query invalidations — one burst, not one per event. */
const FLUSH_MS = 60;

/** First value of a `d` tag, if any. */
function dTagOf(event: NostrEvent): string | undefined {
  for (const t of event.tags) if (t[0] === "d") return t[1];
  return undefined;
}

/**
 * Standing self-state sync. Keeps the current user's own replaceable /
 * addressable events — the ones that describe who they are and what they've
 * joined — continuously mirrored into the local cache and the reading hooks
 * fresh across devices.
 *
 * This is the self-state analogue of {@link ../wire/WireSync}: WireSync owns the
 * standing subscriptions for CONVERSATION timelines; SelfSync owns the standing
 * subscription for the user's OWN lists (follow, mute, NIP-29 servers/channels,
 * Concord V1 + V2 vaults, DM/Blossom relay lists, and Armada's NIP-78 settings).
 *
 * How it works:
 *
 *   1. One long-lived REQ on the pool with a dead-simple filter
 *      `{ authors:[me], kinds:[…] }` (plus a `#d`-scoped filter for the two
 *      addressable kind-30078 documents). No group scoping, no per-relay
 *      cursors — replaceables are latest-wins.
 *   2. Every event that streams past is mirrored into `armada-events` by the
 *      NostrBatcher (the pool's `.req()` wrapper caches automatically), so the
 *      cache is the source of truth exactly as the "sync, not fetch" pattern
 *      wants — data lands in device storage first.
 *   3. Then we invalidate the owning hook's query key(s) so it re-reads and
 *      reconciles through its own merge / decrypt-failed guards. We only
 *      invalidate for an event that is genuinely NEWER than the last one we saw
 *      for that (kind, d) — relays re-emit the same replaceable on reconnect,
 *      and we don't want to churn the vault-decrypt hooks on an echo.
 *
 * Renders nothing.
 */
export function SelfSync() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const pubkey = user?.pubkey;

  useEffect(() => {
    if (!pubkey) return;

    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;

    // Newest created_at seen per (kind + optional d tag), so an echoed
    // replaceable on reconnect doesn't re-invalidate. Scoped to this
    // subscription (fresh on account change).
    const seen = new Map<string, number>();

    // Coalesced invalidation: collect distinct query-key prefixes, flush on a
    // short timer so a burst of self events (initial EOSE catch-up) produces
    // one invalidation pass, not one per event.
    let pendingKeys = new Map<string, readonly string[]>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      const batch = pendingKeys;
      pendingKeys = new Map();
      for (const queryKey of batch.values()) {
        queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
    };
    const scheduleInvalidate = (keys: readonly (readonly string[])[]) => {
      for (const key of keys) pendingKeys.set(key.join("\u0000"), key);
      if (pendingKeys.size > 0 && flushTimer === undefined) {
        flushTimer = setTimeout(flush, FLUSH_MS);
      }
    };

    const onEvent = (event: NostrEvent) => {
      const dTag = event.kind === KIND_APP_SPECIFIC ? dTagOf(event) : undefined;
      const keys = queryKeysForSelfEvent(event.kind, dTag);
      if (keys.length === 0) return; // cached, but no query watches it (e.g. 10063)

      const seenKey = dTag !== undefined ? `${event.kind}:${dTag}` : String(event.kind);
      const prev = seen.get(seenKey) ?? 0;
      if (event.created_at <= prev) return; // echo of a version we've already handled
      seen.set(seenKey, event.created_at);

      scheduleInvalidate(keys);
    };

    // Bare replaceables in one filter; addressable 30078 in a `#d`-scoped one.
    const filters: NostrFilter[] = [
      { authors: [pubkey], kinds: SELF_SYNC_REPLACEABLE_KINDS, since },
      { authors: [pubkey], kinds: [KIND_APP_SPECIFIC], "#d": SELF_SYNC_DTAGS, since },
    ];

    void (async () => {
      try {
        // The batcher mirrors every EVENT here into armada-events as it streams
        // past, so the cache is populated before we invalidate.
        for await (const msg of nostr.req(filters, { signal: controller.signal })) {
          if (msg[0] === "EVENT") onEvent(msg[2] as NostrEvent);
        }
      } catch {
        // Subscription ended (abort / relay drop). NRelay1 reconnects
        // transparently; an account change re-runs this effect.
      }
    })();

    return () => {
      controller.abort();
      if (flushTimer !== undefined) clearTimeout(flushTimer);
    };
  }, [nostr, pubkey, queryClient]);

  return null;
}

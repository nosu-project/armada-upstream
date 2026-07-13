import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { SYNCED_CONFIG_KEYS, type AppConfig } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  getLastSettingsWrite,
  getLocalSettingsSync,
  setLocalSettingsSync,
  useEncryptedSettings,
} from "@/hooks/useEncryptedSettings";
import { useTheme } from "@/hooks/useTheme";
import { useReadState } from "@/hooks/useReadState";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { parseBlossomServerList } from "@/lib/blossom";
import { KIND_BLOSSOM_SERVERS } from "@/hooks/useBlossomServerList";
import { PINNED_RAIL_RELAYS } from "@/lib/platform";
import { type EncryptedSettings } from "@/lib/schemas";
import {
  KIND_APP_SPECIFIC,
  queryKeysForSelfEvent,
  SELF_SYNC_DTAGS,
  SELF_SYNC_REPLACEABLE_KINDS,
} from "@/lib/selfSyncKinds";
import { ACTIVE_THEME_KIND, parseDittoTheme } from "@/lib/themeEvent";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Debounce for pushing local config changes to the encrypted NIP-78 event. */
const PUBLISH_DEBOUNCE_MS = 800;

/**
 * Look-back applied to the standing self-state REQ's `since` on (re)subscribe:
 * a short window so a replaceable published while we were briefly offline is
 * caught. Replaceables are latest-wins, so no persisted cursor is needed — we
 * just want the newest version, and the store dedupes by id.
 */
const SELF_SYNC_LOOKBACK_SECONDS = 5 * 60;

/** Coalescing window (ms) for self-state query invalidations. */
const SELF_SYNC_FLUSH_MS = 60;

/** First value of a `d` tag on an event, if any. */
function dTagOf(event: NostrEvent): string | undefined {
  for (const t of event.tags) if (t[0] === "d") return t[1];
  return undefined;
}

/** Pick just the synced fields out of AppConfig, dropping undefined values. */
function syncedSubset(config: AppConfig): Partial<EncryptedSettings> {
  const out: Record<string, unknown> = {};
  for (const key of SYNCED_CONFIG_KEYS) {
    const value = config[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<EncryptedSettings>;
}

/**
 * The self-state sync. One component owns everything about the LOGGED-IN USER'S
 * OWN state — the replaceable/addressable events that describe who they are and
 * what they've joined — keeping it synced across devices in both directions.
 * (Its sibling {@link ../wire/WireSync} owns CONVERSATION-timeline sync.)
 *
 * Two layers:
 *
 * A. Transport / freshness (the standing subscription). A single long-lived REQ
 *    `{ authors:[me], kinds:[…] }` (plus a `#d`-scoped filter for the two
 *    addressable kind-30078 documents) streams every new version of the user's
 *    own lists: follow, mute, NIP-29 servers/channels (10009), Concord V1/V2
 *    vaults, DM/Blossom relay lists, and Armada's NIP-78 settings. Events land
 *    in the `armada-events` cache first (the NostrBatcher mirrors `.req()`
 *    output), then the owning hook's query key is invalidated so it re-reads and
 *    reconciles through its OWN merge / decrypt-failed guards. This is what makes
 *    a join/leave/add on another device reach this one in real time — the
 *    community rail no longer waits for a remount or a staleTime lapse.
 *
 * B. Application (this data → runtime state). Adapted from Ditto's NostrSync:
 *    1. Pulls Armada's encrypted settings (30078, d="armada/metadata") into
 *       AppConfig (SYNCED_CONFIG_KEYS), timestamp-guarded so a stale relay event
 *       never clobbers a fresh local edit; re-applies whenever a newer remote
 *       event arrives (layer A invalidates → the query re-reads → this fires).
 *    1a. Read-state hydration from the same event.
 *    1b. Hydrates `addedRelays` from the NIP-29 server list (10009 `r` tags) —
 *        the cross-device source of truth for the server rail. Re-merged on
 *        every list change (union only, never replace).
 *    1c. Blossom media server list (10063) → config.
 *    2. Publishes local config changes back to the encrypted event (debounced),
 *       so every AppConfig edit syncs across devices.
 *    3. Interop: adopt the user's Ditto active profile theme (16767) if they've
 *       never picked a theme in Armada.
 *
 * Renders nothing.
 */
export function NostrSync() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const { settings, updateSettings, hasNip44Support, isSuccess } = useEncryptedSettings();
  const { data: groupList } = useUserGroupList();
  const { hydrate: hydrateReadState } = useReadState();
  const { applyCustomTheme } = useTheme();
  const queryClient = useQueryClient();

  const dittoCheckedPubkey = useRef<string | undefined>(undefined);
  const blossomAppliedPubkey = useRef<string | undefined>(undefined);
  // The remote sync timestamp we've most recently folded into local config.
  const appliedSyncTs = useRef<number>(-1);
  // Whether the initial incoming pull has settled for the current account.
  // Gate outgoing publishes on this so we never republish local defaults over
  // a good remote copy before we've had a chance to read it.
  const pulledForPubkey = useRef<string | undefined>(undefined);
  // Serialized synced subset last known to match the remote event, so the
  // publish watcher can skip no-op writes (including the config change caused
  // by applying an incoming pull).
  const lastSyncedSnapshot = useRef<string | undefined>(undefined);
  const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset guards when the account changes.
  useEffect(() => {
    appliedSyncTs.current = -1;
    pulledForPubkey.current = undefined;
    lastSyncedSnapshot.current = undefined;
    blossomAppliedPubkey.current = undefined;
  }, [user?.pubkey]);

  // ─── A. Standing self-state subscription (transport / freshness) ──────
  // One long-lived REQ for the user's own replaceable/addressable events. Each
  // event is mirrored into the cache by the batcher, then the owning hook's
  // query key is invalidated so it re-reads. Echoes (a relay re-emitting the
  // same replaceable on reconnect) are suppressed by created_at; invalidations
  // are coalesced so an EOSE catch-up burst is one pass, not one per event.
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!pubkey) return;

    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - SELF_SYNC_LOOKBACK_SECONDS;

    // Newest created_at seen per (kind + optional d tag), scoped to this sub.
    const seen = new Map<string, number>();

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
        flushTimer = setTimeout(flush, SELF_SYNC_FLUSH_MS);
      }
    };

    const onEvent = (event: NostrEvent) => {
      const dTag = event.kind === KIND_APP_SPECIFIC ? dTagOf(event) : undefined;
      const keys = queryKeysForSelfEvent(event.kind, dTag);
      if (keys.length === 0) return; // cached, but no query watches it (e.g. 10063)

      const seenKey = dTag !== undefined ? `${event.kind}:${dTag}` : String(event.kind);
      const prev = seen.get(seenKey) ?? 0;
      if (event.created_at <= prev) return; // echo of a version already handled
      seen.set(seenKey, event.created_at);

      scheduleInvalidate(keys);
    };

    const filters: NostrFilter[] = [
      { authors: [pubkey], kinds: SELF_SYNC_REPLACEABLE_KINDS, since },
      { authors: [pubkey], kinds: [KIND_APP_SPECIFIC], "#d": SELF_SYNC_DTAGS, since },
    ];

    void (async () => {
      try {
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
  }, [nostr, user?.pubkey, queryClient]);

  // ─── 1. Armada encrypted settings → local config ─────────────────────
  useEffect(() => {
    if (!user?.pubkey) return;

    // Wait for the settings pull to complete at least once. The real guard
    // against clobbering a good remote config with local defaults is below
    // (we open the publish gate only after positively observing a remote
    // event, and section 2 refuses to publish with a null base) — this just
    // avoids acting on an in-flight query.
    if (!isSuccess) return;

    const remoteTs = settings?.lastSync ?? 0;
    const localTs = Math.max(getLocalSettingsSync(user.pubkey), getLastSettingsWrite());

    // Only apply a remote event that is both newer than our local edits and
    // newer than what we've already folded in (so periodic refetch re-applies
    // fresh cross-device changes without thrashing on the same event).
    if (settings && remoteTs > localTs && remoteTs > appliedSyncTs.current) {
      const merged: Partial<AppConfig> = {};
      for (const key of SYNCED_CONFIG_KEYS) {
        const value = settings[key as keyof EncryptedSettings];
        if (value !== undefined) {
          (merged as Record<string, unknown>)[key] = value;
        }
      }
      // addedRelays is a union cache, never a wholesale replace (a partial
      // remote list must not drop servers we know about locally).
      updateConfig((current) => {
        const next = { ...current, ...merged };
        if (Array.isArray(merged.addedRelays)) {
          const have = new Set(current.addedRelays);
          next.addedRelays = [
            ...current.addedRelays,
            ...merged.addedRelays.filter((url) => !have.has(url)),
          ];
        }
        // Record what we just applied so the publish watcher treats it as
        // already-synced and doesn't echo it straight back out.
        lastSyncedSnapshot.current = JSON.stringify(syncedSubset(next));
        return next;
      });
      setLocalSettingsSync(user.pubkey, remoteTs);
      appliedSyncTs.current = remoteTs;
    }

    // Open the outgoing-publish gate ONLY once we have positively observed the
    // user's own remote settings event. Rationale:
    //
    //   • `nostr.query` (NPool) silently swallows relay errors/timeouts and
    //     returns whatever it collected before a 1s EOSE — so a slow or dead
    //     relay yields an empty result indistinguishable from "no event". We
    //     must never treat that ambiguity as license to publish.
    //   • `updateSettings` builds the new 30078 event by merging the local
    //     synced subset over `settings.data ?? {}`. If `settings` is null
    //     (no remote observed), that base is empty, so the published event
    //     DROPS every key not present in local defaults — a replaceable-event
    //     wipe of the user's real config, stamped newest so it wins on every
    //     device. This is the bug.
    //   • A user with no metadata event simply runs on app defaults. There is
    //     nothing to sync and no reason to fabricate a config for them.
    //
    // So: no observed remote event → gate stays closed → we never auto-publish.
    // The gate opens the moment we read a real event (this session, or a prior
    // one via the persisted local sync marker), after which genuine user edits
    // publish and merge safely over the known-good remote base.
    const observedRemote = settings !== null || getLocalSettingsSync(user.pubkey) > 0;
    if (observedRemote) {
      pulledForPubkey.current = user.pubkey;
    }
  }, [user?.pubkey, settings, isSuccess, updateConfig]);

  // ─── 2. Local config → encrypted settings (debounced publish) ─────────
  // A DIRECT user config edit (theme, relays, orders, last-open channel, …) is
  // pushed to the NIP-78 event so it syncs across devices. This is the ONLY
  // place Armada broadcasts a settings event, and it must fire only for a real
  // user mutation — never off boot-time or sync-driven config changes:
  //
  //   • `pulledForPubkey` gates on having observed the user's remote event, so
  //     we never publish a merge that would drop keys we simply failed to read
  //     (the initial-sync wipe).
  //   • Sync-driven mutations (sections 1 / 1b / 1c) keep `lastSyncedSnapshot`
  //     in lockstep, so the diff below can only ever reflect a user edit.
  //   • As a last belt-and-braces guard we require a non-null `settings` base
  //     at publish time: `updateSettings` merges the patch over `settings.data`,
  //     and merging over null would replace the remote event with just the
  //     local subset — the very wipe we're preventing.
  useEffect(() => {
    if (!user?.pubkey || !hasNip44Support) return;
    if (pulledForPubkey.current !== user.pubkey) return;

    const snapshot = JSON.stringify(syncedSubset(config));
    if (lastSyncedSnapshot.current === undefined) {
      // First observation post-pull: adopt current state as the baseline
      // (matches what the pull applied, or the local defaults if none).
      lastSyncedSnapshot.current = snapshot;
      return;
    }
    if (snapshot === lastSyncedSnapshot.current) return;

    // Never publish while we lack a known-good remote base to merge over —
    // doing so would replace the user's real settings event with only the
    // local synced subset, dropping every key we haven't observed.
    if (settings === null) return;

    if (publishTimer.current) clearTimeout(publishTimer.current);
    publishTimer.current = setTimeout(() => {
      lastSyncedSnapshot.current = snapshot;
      updateSettings(syncedSubset(config)).catch((err) =>
        console.warn("Config sync failed:", err),
      );
    }, PUBLISH_DEBOUNCE_MS);

    return () => {
      if (publishTimer.current) clearTimeout(publishTimer.current);
    };
  }, [user?.pubkey, hasNip44Support, config, settings, updateSettings]);

  // ─── 1a. Read-state (unread/mention) → local read-state cache ─────────
  // Merge-hydrate (max timestamp wins) so synced reads from other devices
  // mark conversations read here too. Safe to run on every settings change.
  useEffect(() => {
    if (!user?.pubkey || !settings?.readState) return;
    hydrateReadState(settings.readState);
  }, [user?.pubkey, settings?.readState, hydrateReadState]);

  // ─── 1b. NIP-29 server list (kind 10009 `r` tags) → addedRelays cache ──
  // The 10009 list is the cross-device source of truth for added servers;
  // localStorage `addedRelays` is just a fast/offline cache. Hydrate by MERGING
  // the list into the local cache (union) — never by replacing it. Replacing
  // was catastrophic: any transient empty/partial/failed-decrypt read of the
  // 10009 event (slow relay, signer not ready) would overwrite `addedRelays`
  // with [] and the whole server rail would vanish. A union only ever ADDS
  // servers the list knows about; explicit removals update `addedRelays`
  // directly at the call site (ServerPage), so we don't need the list to drive
  // removals here.
  //
  // Re-runs on EVERY list change (not once per account): the standing
  // self-state REQ (layer A) invalidates the 10009 query when another device
  // adds a server, `groupList` re-reads, and this merges the new server into
  // the rail live. The union + idempotent `updateConfig` make repeated runs
  // free when nothing changed.
  useEffect(() => {
    if (!user?.pubkey || !groupList) return;

    // Nothing trustworthy to merge from: no event yet, or its encrypted items
    // failed to decrypt (servers would read empty). Wait for a real list.
    if (!groupList.event || groupList.decryptFailed) return;

    // Opt-in auto-pinned relays (`PINNED_RAIL_RELAYS`, empty by default) are
    // always in the rail regardless of the list, so they needn't be cached;
    // everything else the list knows about is merged in.
    const pinned = new Set(PINNED_RAIL_RELAYS);
    const fromList = groupList.servers.filter((url) => !pinned.has(url));
    if (fromList.length === 0) return;

    updateConfig((current) => {
      const have = new Set(current.addedRelays);
      const missing = fromList.filter((url) => !have.has(url));
      if (missing.length === 0) return current;
      const next = { ...current, addedRelays: [...current.addedRelays, ...missing] };
      // This is a SYNC-DRIVEN mutation (hydrating the user's own 10009 server
      // list into the local cache), not a user edit. Keep the publish baseline
      // in lockstep so the publish watcher never mistakes it for one and
      // broadcasts it back out. We only ever broadcast direct user edits.
      if (pulledForPubkey.current === user.pubkey) {
        lastSyncedSnapshot.current = JSON.stringify(syncedSubset(next));
      }
      return next;
    });
  }, [user?.pubkey, groupList, updateConfig]);

  // ─── 1c. Blossom server list (kind 10063 `server` tags) → config ──────
  // The 10063 event is the cross-device source of truth for the user's
  // Blossom media servers (BUD-03); `config.blossomServerMetadata` is the
  // fast/offline cache. Apply only when the event is newer than what we hold
  // (`updatedAt` is the created_at of the last list we synced) and non-empty
  // — a transient empty/failed read must never wipe a good local list.
  // Mirrors Ditto's NostrSync 10063 hydration. Runs once per account.
  useEffect(() => {
    if (!user?.pubkey) return;
    if (blossomAppliedPubkey.current === user.pubkey) return;
    blossomAppliedPubkey.current = user.pubkey;

    let cancelled = false;

    (async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [KIND_BLOSSOM_SERVERS], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(6000) },
        );
        const event = events.sort((a, b) => b.created_at - a.created_at)[0];
        if (!event || cancelled) return;
        const servers = parseBlossomServerList(event);
        if (servers.length === 0) return;
        updateConfig((current) => {
          if (event.created_at <= current.blossomServerMetadata.updatedAt) return current;
          const next = {
            ...current,
            blossomServerMetadata: { servers, updatedAt: event.created_at },
          };
          // Sync-driven (hydrating the user's own 10063 list), not a user edit
          // — keep the publish baseline in lockstep so it isn't broadcast back.
          if (pulledForPubkey.current === user.pubkey) {
            lastSyncedSnapshot.current = JSON.stringify(syncedSubset(next));
          }
          return next;
        });
      } catch {
        // Relay error — keep the local cache.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.pubkey, nostr, updateConfig]);

  // ─── 2. Ditto active profile theme fallback (first-time Armada users) ─
  useEffect(() => {
    if (!user?.pubkey) return;
    if (dittoCheckedPubkey.current === user.pubkey) return;

    // Only adopt the Ditto theme if the user has no Armada theme yet:
    // never synced Armada settings AND still on the untouched default.
    const hasArmadaSettings =
      getLocalSettingsSync(user.pubkey) > 0 || (settings && (settings.lastSync ?? 0) > 0);
    const usingDefault = config.theme === "dark" && !config.customTheme;
    if (hasArmadaSettings || !usingDefault) {
      dittoCheckedPubkey.current = user.pubkey;
      return;
    }

    dittoCheckedPubkey.current = user.pubkey;
    let cancelled = false;

    (async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [ACTIVE_THEME_KIND], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(6000) },
        );
        const event = events.sort((a, b) => b.created_at - a.created_at)[0];
        if (!event || cancelled) return;
        const theme = parseDittoTheme(event);
        if (theme && !cancelled) {
          applyCustomTheme({ title: theme.title, colors: theme.colors });
        }
      } catch {
        // No Ditto theme / relay error — keep Armada's default.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.pubkey, settings, config.theme, config.customTheme, nostr, applyCustomTheme]);

  return null;
}

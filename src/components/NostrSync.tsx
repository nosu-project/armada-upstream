import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useBootGateOpen } from "@/lib/bootGate";

import { setBuzzMediaSigner } from "@/buzz/media";
import { accountDataRelays, SYNCED_CONFIG_KEYS, type AppConfig } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  getLastSettingsWrite,
  getLocalSettingsSync,
  setLastSettingsWrite,
  setLocalSettingsSync,
  useEncryptedSettings,
} from "@/hooks/useEncryptedSettings";
import {
  getFrequentReactions,
  hydrateFrequentReactions,
  subscribeFrequentReactions,
} from "@/hooks/useFrequentReactions";
import { useFavoriteGifsSync } from "@/hooks/useFavoriteGifsSync";
import { useBlossomServerList } from "@/hooks/useBlossomServerList";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useSearchRelayList } from "@/hooks/useSearchRelayList";
import { useTheme } from "@/hooks/useTheme";
import { useReadState } from "@/hooks/useReadState";
import { parseRelayList, KIND_RELAY_LIST } from "@/lib/nip65";
import { type EncryptedSettings } from "@/lib/schemas";
import {
  KIND_APP_SPECIFIC,
  queryKeysForSelfEvent,
  SELF_SYNC_DTAGS,
  SELF_SYNC_REPLACEABLE_KINDS,
  T_ARMADA_GIF_FAVORITES,
} from "@/lib/selfSyncKinds";
import { ACTIVE_THEME_KIND, parseDittoTheme } from "@/lib/themeEvent";
import { syncedConfigSnapshot } from "@/lib/syncedConfig";
import { setPreferredVoiceServer } from "@/lib/voiceDevices";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Debounce for pushing local config changes to the encrypted NIP-78 event. */
const PUBLISH_DEBOUNCE_MS = 800;

/**
 * Debounce for the quick-reaction frequency table. Longer than the config one:
 * reacting is a rapid, repeatable act and the table is a convenience cache, so
 * it isn't worth a settings event per tap.
 */
const FREQUENT_REACTIONS_DEBOUNCE_MS = 10_000;

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

/**
 * The self-state sync. One component owns everything about the LOGGED-IN USER'S
 * OWN state — the replaceable/addressable events that describe who they are and
 * what they've joined — keeping it synced across devices in both directions.
 * (Its sibling {@link ../wire/WireSync} owns CONVERSATION-timeline sync.)
 *
 * Two layers:
 *
 * A. Transport / freshness (the standing subscription). A single long-lived REQ
 *    `{ authors:[me], kinds:[…] }` (plus scoped filters for Armada's
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
 *    (There is no 1b. It used to hydrate the 10009 `r` tags into an
 *        `addedRelays` config cache; the rail now reads that list directly.)
 *    1c. Blossom media server list (10063) → config.
 *    2. Publishes local config changes back to the encrypted event (debounced),
 *       so every AppConfig edit syncs across devices.
 *    3. Interop: adopt the user's Ditto active profile theme (16767) if they've
 *       never picked a theme in Armada.
 *
 * Renders nothing.
 */
export function NostrSync() {
  // Boot-gated: everything here is network catch-up (settings, lists, relay
  // discovery) that used to fan out the moment the providers mounted and
  // compete with the first paint's local reads. Starting after the gate opens
  // loses nothing — every fetch here is a full read, not a delta.
  const bootGateOpen = useBootGateOpen();
  return bootGateOpen ? <NostrSyncInner /> : null;
}

function NostrSyncInner() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const { settings, updateSettings, hasNip44Support, isSuccess } = useEncryptedSettings();
  const blossomServerList = useBlossomServerList();
  const dmRelayList = useDmRelayList();
  const searchRelayList = useSearchRelayList();
  const { hydrate: hydrateReadState } = useReadState();
  const { applyCustomTheme } = useTheme();
  const queryClient = useQueryClient();
  const selfRelayKey = accountDataRelays(config, user?.pubkey).sort().join("\u0000");
  useFavoriteGifsSync();

  const dittoCheckedPubkey = useRef<string | undefined>(undefined);
  const blossomAppliedEvent = useRef<string | undefined>(undefined);
  const dmRelaysAppliedEvent = useRef<string | undefined>(undefined);
  const searchRelaysAppliedEvent = useRef<string | undefined>(undefined);
  const relayListAppliedPubkey = useRef<string | undefined>(undefined);
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
  // Latest settings, readable from a debounced callback without making every
  // settings change tear down and rebuild that subscription.
  const settingsRef = useRef<EncryptedSettings | null>(null);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Publish the current signer to the Buzz media module so Buzz-hosted images
  // and avatars can be fetched with a signed BUD-11 GET header from any render
  // site without each pulling `useCurrentUser`.
  useEffect(() => {
    setBuzzMediaSigner(user?.signer);
  }, [user?.signer]);

  // Reset guards when the account changes.
  useEffect(() => {
    appliedSyncTs.current = -1;
    pulledForPubkey.current = undefined;
    lastSyncedSnapshot.current = undefined;
    blossomAppliedEvent.current = undefined;
    dmRelaysAppliedEvent.current = undefined;
    searchRelaysAppliedEvent.current = undefined;
    relayListAppliedPubkey.current = undefined;
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
      const topicTag = event.tags.find((tag) => tag[0] === "t")?.[1];
      const keys = queryKeysForSelfEvent(event.kind, dTag, topicTag);
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
      { authors: [pubkey], kinds: [KIND_APP_SPECIFIC], "#t": [T_ARMADA_GIF_FAVORITES], since },
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
  }, [nostr, user?.pubkey, queryClient, selfRelayKey]);

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
      // Every synced key applies wholesale. The blob used to also carry
      // `addedRelays`, union-merged — which made it a server RE-ADD channel:
      // a blob written before a removal still listed the removed server and
      // put it back on every device, forever. The server set now lives only in
      // the kind 10009 list, so there is nothing here to union.
      updateConfig((current) => {
        const next = { ...current, ...merged };
        // Record what we just applied so the publish watcher treats it as
        // already-synced and doesn't echo it straight back out.
        lastSyncedSnapshot.current = JSON.stringify(syncedConfigSnapshot(next));
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

    const snapshot = JSON.stringify(syncedConfigSnapshot(config));
    if (lastSyncedSnapshot.current === undefined) {
      // First observation post-pull: adopt current state as the baseline
      // (matches what the pull applied, or the local defaults if none).
      lastSyncedSnapshot.current = snapshot;
      return;
    }
    if (snapshot === lastSyncedSnapshot.current) return;

    // A genuine user edit was just observed. Stamp the local-write clock NOW,
    // before the debounce, so section 1's `remoteTs > localTs` guard protects
    // this edit against a stale relay copy that lands during the debounce
    // window (the "my change reverted" race). `updateSettings` re-stamps it at
    // actual publish time; this only closes the gap in between.
    setLastSettingsWrite(Date.now());

    // Never publish while we lack a known-good remote base to merge over —
    // doing so would replace the user's real settings event with only the
    // local synced subset, dropping every key we haven't observed.
    if (settings === null) return;

    if (publishTimer.current) clearTimeout(publishTimer.current);
    publishTimer.current = setTimeout(() => {
      lastSyncedSnapshot.current = snapshot;
      updateSettings(syncedConfigSnapshot(config)).catch((err) =>
        console.warn("Config sync failed:", err),
      );
    }, PUBLISH_DEBOUNCE_MS);

    return () => {
      if (publishTimer.current) clearTimeout(publishTimer.current);
    };
  }, [user?.pubkey, hasNip44Support, config, settings, updateSettings]);

  // The portable voice-server preference is synchronized in AppConfig, while
  // the voice runtime still reads its established localStorage key. Keep that
  // bridge current after login and whenever another device changes the value.
  useEffect(() => {
    setPreferredVoiceServer(config.preferredVoiceServer);
  }, [config.preferredVoiceServer]);

  // ─── 1a. Read-state (unread/mention) → local read-state cache ─────────
  // Merge-hydrate (max timestamp wins) so synced reads from other devices
  // mark conversations read here too. Safe to run on every settings change.
  useEffect(() => {
    if (!user?.pubkey || !settings?.readState) return;
    hydrateReadState(settings.readState);
  }, [user?.pubkey, settings?.readState, hydrateReadState]);

  // ─── 1d. Quick-reaction frequency table ↔ encrypted settings ──────────
  // Merge-hydrate (max count / most recent use per emoji) so the quick row on
  // a new device starts from the emoji the user actually reaches for. Safe to
  // run on every settings change: the merge is a no-op write when nothing
  // moved.
  useEffect(() => {
    if (!user?.pubkey || !settings?.frequentReactions) return;
    hydrateFrequentReactions(user.pubkey, settings.frequentReactions);
  }, [user?.pubkey, settings?.frequentReactions]);

  // …and push the other way, debounced, on a user-initiated reaction only
  // (`subscribeFrequentReactions` never fires for the hydrate above, so two
  // devices can't ping-pong the table between them).
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!pubkey || !hasNip44Support) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeFrequentReactions((changed) => {
      if (changed !== pubkey) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // Same guard as section 2: `updateSettings` merges the patch over the
        // last read settings, so publishing without a known-good base would
        // replace the user's real settings event with just this one key.
        if (settingsRef.current === null) return;
        updateSettings({ frequentReactions: getFrequentReactions(pubkey) }).catch((err) =>
          console.warn("Frequent-reaction sync failed:", err),
        );
      }, FREQUENT_REACTIONS_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [user?.pubkey, hasNip44Support, updateSettings]);

  // NOTE: there is no longer a "1b" section hydrating the kind 10009 server
  // list into a local config cache. That cache (`addedRelays`) is gone: the
  // rail reads the 10009 list directly, via its own folded offline snapshot.
  // The hydration had to be a UNION — a transient empty/failed-decrypt read
  // must never wipe the rail — and a union can only ever ADD, so every stale
  // relay copy re-added servers the user had just removed. The tombstone
  // machinery that vetoed those re-adds is gone with it.

  // ─── 1c. Blossom server list (kind 10063 `server` tags) → config ──────
  // The 10063 event is the cross-device source of truth for the user's
  // Blossom media servers (BUD-03); `config.blossomServerMetadata` is the
  // fast/offline cache. Apply only when the event is newer than what we hold
  // (`updatedAt` is the created_at of the last list we synced). A signed empty
  // event intentionally clears the list; a missing/failed read has no event
  // and therefore never wipes a good local value.
  // Mirrors Ditto's NostrSync 10063 hydration. The owning query is invalidated
  // by the standing self-state subscription, so later cross-device edits apply
  // without a reload too.
  useEffect(() => {
    const event = blossomServerList.event;
    if (!user?.pubkey || !event || blossomAppliedEvent.current === event.id) return;
    blossomAppliedEvent.current = event.id;
    updateConfig((current) => {
      if (event.created_at <= current.blossomServerMetadata.updatedAt) return current;
      const next = {
        ...current,
        blossomServerMetadata: {
          servers: blossomServerList.servers,
          updatedAt: event.created_at,
        },
      };
      if (pulledForPubkey.current === user.pubkey) {
        lastSyncedSnapshot.current = JSON.stringify(syncedConfigSnapshot(next));
      }
      return next;
    });
  }, [user?.pubkey, blossomServerList.event, blossomServerList.servers, updateConfig]);

  // ─── 1d. Standard search + DM relay lists → config ────────────────────
  // A signed empty replacement is an intentional clear, unlike a missing
  // result. The hooks expose the event separately so we can apply the former
  // and ignore the latter without ever treating a failed read as an empty list.
  useEffect(() => {
    const event = searchRelayList.event;
    if (!user?.pubkey || !event || searchRelaysAppliedEvent.current === event.id) return;
    searchRelaysAppliedEvent.current = event.id;
    updateConfig((current) => {
      const next = { ...current, searchRelays: searchRelayList.relays };
      if (pulledForPubkey.current === user.pubkey) {
        lastSyncedSnapshot.current = JSON.stringify(syncedConfigSnapshot(next));
      }
      return next;
    });
  }, [user?.pubkey, searchRelayList.event, searchRelayList.relays, updateConfig]);

  useEffect(() => {
    const event = dmRelayList.event;
    if (!user?.pubkey || !event || dmRelaysAppliedEvent.current === event.id) return;
    dmRelaysAppliedEvent.current = event.id;
    updateConfig((current) => {
      const next = { ...current, dmRelays: dmRelayList.relays };
      if (pulledForPubkey.current === user.pubkey) {
        lastSyncedSnapshot.current = JSON.stringify(syncedConfigSnapshot(next));
      }
      return next;
    });
  }, [user?.pubkey, dmRelayList.event, dmRelayList.relays, updateConfig]);

  // ─── 1e. NIP-65 relay list (kind 10002 `r` tags) → config ─────────────
  // The user's own relay list is mirrored here; publishing is available only
  // through explicit controls in Settings.
  // Apply only when the event is newer than what we hold and non-empty, so a
  // transient empty/failed read never wipes a good local mirror. Exactly the
  // shape of the 10063 block above; runs once per account.
  useEffect(() => {
    if (!user?.pubkey) return;
    if (relayListAppliedPubkey.current === user.pubkey) return;
    relayListAppliedPubkey.current = user.pubkey;

    let cancelled = false;

    (async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [KIND_RELAY_LIST], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(6000) },
        );
        const event = events.sort((a, b) => b.created_at - a.created_at)[0];
        if (!event || cancelled) return;
        const relays = parseRelayList(event);
        if (relays.length === 0) return;
        updateConfig((current) => {
          const sameOwner = current.relayMetadata.pubkey === user.pubkey;
          if (sameOwner && event.created_at <= current.relayMetadata.updatedAt) return current;
          const next = {
            ...current,
            appRelays: current.appRelays.length === 0
              ? relays.map((relay) => relay.url)
              : current.appRelays,
            relayMetadata: { relays, updatedAt: event.created_at, pubkey: user.pubkey },
          };
          // Sync-driven (hydrating the user's own 10002 list), not a user edit
          // — keep the publish baseline in lockstep so it isn't broadcast back.
          if (pulledForPubkey.current === user.pubkey) {
            lastSyncedSnapshot.current = JSON.stringify(syncedConfigSnapshot(next));
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

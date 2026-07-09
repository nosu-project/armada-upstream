import { useNostr } from "@nostrify/react";
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
import { ACTIVE_THEME_KIND, parseDittoTheme } from "@/lib/themeEvent";

/** Debounce for pushing local config changes to the encrypted NIP-78 event. */
const PUBLISH_DEBOUNCE_MS = 800;

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
 * Bridges the user's app config to/from Nostr on login / account switch and
 * whenever it changes. Adapted from Ditto's NostrSync.
 *
 *  1. Pulls Armada's own encrypted settings (NIP-78, kind 30078,
 *     d="armada/metadata") into AppConfig — the full synced field set
 *     (SYNCED_CONFIG_KEYS) — timestamp-guarded so a stale relay event never
 *     clobbers a fresh local edit. Re-applies whenever a newer remote event
 *     arrives (periodic refetch / another device).
 *  1a. Read-state hydration from the same event.
 *  1b. Hydrates the `addedRelays` cache from the user's NIP-29 server list
 *     (kind 10009 `r` tags), which is the cross-device source of truth.
 *  2. Publishes local config changes back to the encrypted event (debounced),
 *     so every AppConfig edit — not just theme — syncs across devices.
 *  3. Interop: if the user has never picked a theme in Armada, adopt their
 *     Ditto *active profile theme* (kind 16767) so Ditto users feel at home.
 *
 * Renders nothing.
 */
export function NostrSync() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const { settings, updateSettings, hasNip44Support, isFetched } = useEncryptedSettings();
  const { data: groupList } = useUserGroupList();
  const { hydrate: hydrateReadState } = useReadState();
  const { applyCustomTheme } = useTheme();

  const dittoCheckedPubkey = useRef<string | undefined>(undefined);
  const serversAppliedPubkey = useRef<string | undefined>(undefined);
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
    serversAppliedPubkey.current = undefined;
    blossomAppliedPubkey.current = undefined;
  }, [user?.pubkey]);

  // ─── 1. Armada encrypted settings → local config ─────────────────────
  useEffect(() => {
    if (!user?.pubkey) return;

    // Wait for the settings query to resolve at least once. Once it has, we can
    // start publishing local changes (there's nothing newer to pull that would
    // clobber them). `settings` is null when it resolved with no event.
    if (!isFetched) return;

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

    pulledForPubkey.current = user.pubkey;
  }, [user?.pubkey, settings, isFetched, updateConfig]);

  // ─── 2. Local config → encrypted settings (debounced publish) ─────────
  // Every AppConfig edit (theme, relays, orders, last-open channel, …) is
  // pushed to the NIP-78 event so it syncs across devices. Gated on having
  // completed the initial pull to avoid clobbering the remote with defaults.
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
  }, [user?.pubkey, hasNip44Support, config, updateSettings]);

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
  // removals here. Runs once per account after the list query resolves.
  useEffect(() => {
    if (!user?.pubkey || !groupList) return;
    if (serversAppliedPubkey.current === user.pubkey) return;

    // Nothing trustworthy to merge from: no event yet, or its encrypted items
    // failed to decrypt (servers would read empty). Wait for a real list.
    if (!groupList.event || groupList.decryptFailed) return;

    serversAppliedPubkey.current = user.pubkey;

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
      return { ...current, addedRelays: [...current.addedRelays, ...missing] };
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
          return {
            ...current,
            blossomServerMetadata: { servers, updatedAt: event.created_at },
          };
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

import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useBootGateOpen } from "@/lib/bootGate";

import { setBuzzMediaSigner } from "@/buzz/media";
import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useConfigDocSync, markConfigSynced } from "@/hooks/useConfigDocSync";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEncryptedSettings } from "@/hooks/useEncryptedSettings";
import { useSettingsDoc } from "@/hooks/useSettingsDoc";
import { useEventStore } from "@/hooks/useEventStore";
import {
  getFrequentReactions,
  hydrateFrequentReactions,
  subscribeFrequentReactions,
} from "@/hooks/useFrequentReactions";
import { useFavoriteGifsSync } from "@/hooks/useFavoriteGifsSync";
import {
  useDmConversationIndexSync,
  useRecordDmConversationIndex,
} from "@/hooks/useDmConversationIndexSync";
import { useResumeEpoch } from "@/hooks/useResumeEpoch";
import { useBlossomServerList } from "@/hooks/useBlossomServerList";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useSearchRelayList } from "@/hooks/useSearchRelayList";
import { useTheme } from "@/hooks/useTheme";
import { replaceableIsNewerThanMetadata } from "@/lib/canonicalSelfList";
import {
  KIND_RELAY_LIST,
  newerRelayListUpdate,
  relayListIsNewerThanMetadata,
} from "@/lib/nip65";
import {
  admitSelfSyncEvent,
  KIND_APP_SPECIFIC,
  KIND_COMMUNITY_LIST_FRAG,
  queryKeysForSelfEvent,
  selfSyncTopicOf,
  SELF_SYNC_DTAGS,
  SELF_SYNC_OWNER_QUERY_KEYS,
  SELF_SYNC_REPLACEABLE_KINDS,
  SELF_SYNC_TOPIC_TAGS,
  type SelfSyncEventVersion,
} from "@/lib/selfSyncKinds";
import { ACTIVE_THEME_KIND, parseDittoTheme } from "@/lib/themeEvent";
import { savePushPrefs } from "@/lib/pushPrefs";
import { verifyEventOnce } from "@/lib/verifyCache";
import { setPreferredVoiceServer } from "@/lib/voiceDevices";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * Debounce for the quick-reaction frequency table. Longer than the config one:
 * reacting is a rapid, repeatable act and the table is a convenience cache, so
 * it isn't worth a settings event per tap.
 */
const FREQUENT_REACTIONS_DEBOUNCE_MS = 10_000;

/** Coalescing window (ms) for self-state query invalidations. */
const SELF_SYNC_FLUSH_MS = 60;

/**
 * How long the app must have been backgrounded before the standing self-state
 * REQ is torn down and rebuilt on return. An alt-tab missed nothing and isn't
 * worth a resubscribe; a phone that spent the night asleep — with a socket that
 * may be half-open, which no reconnect ever fires for — missed everything.
 */
const SELF_SYNC_RESUBSCRIBE_AFTER_AWAY_MS = 30_000;

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
 *    own lists: follow, mute, the NIP-65 pointer (10002), NIP-29
 *    servers/channels (10009), Concord vaults, DM/Blossom relay lists, and
 *    Armada's NIP-78 settings. Events land
 *    in the `armada-events` cache first (the NostrBatcher mirrors `.req()`
 *    output), then the owning hook's query key is invalidated so it re-reads and
 *    reconciles through its OWN merge / decrypt-failed guards. This is what makes
 *    a join/leave/add on another device reach this one in real time — the
 *    community rail no longer waits for a remount or a staleTime lapse.
 *
 * B. Application (this data → runtime state). Adapted from Ditto's NostrSync:
 *    1. Armada's encrypted settings documents (30078, `d=${APP_ID}/…`) ↔
 *       AppConfig, one {@link useConfigDocSync} per document that mirrors
 *       config. Both directions live there, including the debounced publish of
 *       local edits; see `docs/settings-documents.md`.
 *    1a. The quick-reaction frequency table ↔ its own document.
 *    (There is no 1b. It used to hydrate the 10009 `r` tags into an
 *        `addedRelays` config cache; the rail now reads that list directly.
 *        Read-state hydration is likewise gone from here — it moved into
 *        ReadStateProvider, which owns the local map.)
 *    1c. Blossom media server list (10063) → config.
 *    1e. NIP-65 relay-list changes (10002) → config and a restarted self-state
 *        stream on the newly declared write relays.
 *    2. Interop: adopt the user's Ditto active profile theme (16767) if they've
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
  const automaticSettingsSync = config.automaticSettingsSync !== false;
  const { doc: metadata, hasNip44Support } = useEncryptedSettings();
  const reactionsDoc = useSettingsDoc("reactions");
  const { update: updateReactions } = reactionsDoc;
  const eventStore = useEventStore();

  // ─── 1. Settings documents ↔ AppConfig (both directions) ──────────────
  // One instance per document; each owns its own applied-id guard, publish
  // baseline and debounce, so these four can't race one another.
  useConfigDocSync("metadata");
  useConfigDocSync("rail");
  useConfigDocSync("notifications");
  useConfigDocSync("dms");

  const blossomServerList = useBlossomServerList();
  const dmRelayList = useDmRelayList();
  const searchRelayList = useSearchRelayList();
  const { applyCustomTheme } = useTheme();
  const queryClient = useQueryClient();
  const selfRelayKey = selfStateRelays(config, user?.pubkey).sort().join("\u0000");
  useFavoriteGifsSync();
  useDmConversationIndexSync();
  useRecordDmConversationIndex();

  // Bumped when the app returns from a real backgrounding (not an alt-tab),
  // rebuilding the standing subscription below.
  const resumeEpoch = useResumeEpoch(SELF_SYNC_RESUBSCRIBE_AFTER_AWAY_MS);

  const dittoCheckedPubkey = useRef<string | undefined>(undefined);
  const blossomAppliedEvent = useRef<string | undefined>(undefined);
  const dmRelaysAppliedEvent = useRef<string | undefined>(undefined);
  const searchRelaysAppliedEvent = useRef<string | undefined>(undefined);
  // Newest valid kind-10002 applied in this session. Unlike the ordinary echo
  // guard, NIP-01 says the LOWER id wins when two replaceables share a second.
  const relayListSeenVersion = useRef<NostrEvent | undefined>(undefined);
  // NIP-01 winner handled per (kind + optional d tag), across resubscribes.
  const seenSelfVersions = useRef<Map<string, SelfSyncEventVersion>>(new Map());
  // Whether the reactions document has been read from the store, readable
  // from a debounced callback without making every change tear down and
  // rebuild that subscription.
  const reactionsFetched = useRef(false);
  useEffect(() => {
    reactionsFetched.current = reactionsDoc.isFetched;
  }, [reactionsDoc.isFetched]);

  // Publish the current signer to the Buzz media module so Buzz-hosted images
  // and avatars can be fetched with a signed BUD-11 GET header from any render
  // site without each pulling `useCurrentUser`.
  useEffect(() => {
    setBuzzMediaSigner(user?.signer);
  }, [user?.signer]);

  // Reset guards when the account changes.
  useEffect(() => {
    blossomAppliedEvent.current = undefined;
    dmRelaysAppliedEvent.current = undefined;
    searchRelaysAppliedEvent.current = undefined;
    relayListSeenVersion.current = undefined;
    seenSelfVersions.current = new Map();
  }, [user?.pubkey]);

  // A changed account-state destination set is the handoff point: React has
  // committed the new map, the standing effect below will rebuild on it, and
  // every owner gets a fresh read from those relays. Invalid/older 10002 events
  // never change this key and therefore cannot trigger a refetch storm.
  const previousSelfRelayKey = useRef(selfRelayKey);
  useEffect(() => {
    if (previousSelfRelayKey.current === selfRelayKey) return;
    previousSelfRelayKey.current = selfRelayKey;
    for (const queryKey of SELF_SYNC_OWNER_QUERY_KEYS) {
      queryClient.invalidateQueries({ queryKey: [...queryKey] });
    }
  }, [queryClient, selfRelayKey]);

  // ─── A. Standing self-state subscription (transport / freshness) ──────
  // One long-lived REQ for the user's own replaceable/addressable events. Each
  // event is mirrored into the cache by the batcher, then the owning hook's
  // query key is invalidated so it re-reads. Echoes (a relay re-emitting the
  // same replaceable on reconnect) are suppressed by created_at; invalidations
  // are coalesced so an EOSE catch-up burst is one pass, not one per event.
  //
  // The filters carry NO `since`. They used to look back five minutes, which
  // silently made this a live-only channel: a change published from another
  // device an hour ago falls outside the window, so subscribing on app open
  // never delivered it and the rail stayed stale until something else happened
  // to refetch. The window bought nothing — every kind here is replaceable, so
  // a relay stores exactly one version and an unbounded filter returns the same
  // handful of events. Without it, every subscribe (and every NRelay1 reconnect
  // replay) is a full catch-up.
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!pubkey) return;

    // Self-state has an explicit ownership boundary. Falling back to the
    // general pool when this set is empty is not harmless: the combined batch
    // contains kind-10009, which makes pool routing fan the WHOLE request out
    // to joined NIP-29 servers, including encrypted settings, Concord vault
    // coordinates, and the DM/GIF topic markers. With no account-data relay
    // configured there is nowhere appropriate to maintain a standing copy, so
    // stay idle until app or NIP-65 self-state relays become available.
    const relayUrls = selfRelayKey ? selfRelayKey.split("\u0000") : [];
    if (relayUrls.length === 0) return;

    const controller = new AbortController();

    // NIP-01 winner seen per (kind + optional d tag). Held across
    // resubscribes (reset only on account change) so rebuilding the sub on
    // resume re-reads the same replaceables without invalidating all owning
    // query keys for versions we already handled.
    const seen = seenSelfVersions.current;

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
      // A relay can violate our author filter. Never let another account's
      // higher timestamp poison this account's per-coordinate echo guard.
      if (event.pubkey !== pubkey || !verifyEventOnce(event)) return;
      if (event.kind === KIND_RELAY_LIST) {
        const previous = relayListSeenVersion.current;
        // A relay can violate our filter. This verifies the signature/kind,
        // rejects an empty map, and applies NIP-01's timestamp/lower-id order.
        const update = newerRelayListUpdate(
          event,
          previous?.pubkey === pubkey ? previous : undefined,
        );
        if (!update) return;
        const { event: candidate, relays } = update;

        // Compare against the persisted winning id too. Legacy metadata has
        // only a timestamp, so it accepts one equal-second winner and stamps
        // the id; subsequent sessions retain NIP-01's lower-id result.
        const sameOwner = config.relayMetadata.pubkey === pubkey;
        if (sameOwner && !relayListIsNewerThanMetadata(
          candidate,
          config.relayMetadata,
        )) return;
        relayListSeenVersion.current = candidate;

        void eventStore.then((store) => store.event(candidate)).catch(() => undefined);
        updateConfig((current) => {
          const ownsCurrent = current.relayMetadata.pubkey === pubkey;
          if (ownsCurrent && !relayListIsNewerThanMetadata(
            candidate,
            current.relayMetadata,
          )) return current;
          const next = {
            ...current,
            relayMetadata: {
              relays,
              updatedAt: candidate.created_at,
              eventId: candidate.id,
              pubkey,
            },
          };
          // Sync-driven pointer hydration must not flip `useUserRelays` or
          // republish an encrypted config document.
          markConfigSynced(next);
          return next;
        });

        return;
      }

      // Addressable self-kinds dedup per coordinate: the Community List is one
      // event per FRAGMENT, and keying the echo-guard by kind alone would drop
      // fragment 1 as an "echo" of a newer fragment 0.
      const dTag =
        event.kind === KIND_APP_SPECIFIC || event.kind === KIND_COMMUNITY_LIST_FRAG
          ? dTagOf(event)
          : undefined;
      const topicTag = selfSyncTopicOf(event.tags);
      const keys = queryKeysForSelfEvent(event.kind, dTag, topicTag);
      if (keys.length === 0) return; // cached, but no query watches it (e.g. 10063)

      if (!admitSelfSyncEvent(seen, event, dTag)) return;

      // Write it to ArmadaDB, and only THEN tell the readers. The batcher
      // mirrors everything out of `.req()` on its own, but as a fire-and-forget
      // write that races this invalidation — and the settings document is now
      // read from the store, so "invalidated but not yet written" is a re-read
      // of the version we just superseded. Ordering it here is the difference
      // between a live subscription and a live subscription that lands. A
      // duplicate write is a no-op: same id, same coordinate.
      void eventStore
        .then((store) => store.event(event))
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) scheduleInvalidate(keys);
        });
    };

    const filters: NostrFilter[] = [
      { authors: [pubkey], kinds: SELF_SYNC_REPLACEABLE_KINDS },
      ...(automaticSettingsSync
        ? [
            { authors: [pubkey], kinds: [KIND_APP_SPECIFIC], "#d": SELF_SYNC_DTAGS },
            {
              authors: [pubkey],
              kinds: [KIND_APP_SPECIFIC],
              "#t": SELF_SYNC_TOPIC_TAGS,
            },
          ]
        : []),
    ];

    void (async () => {
      try {
        const source = nostr.group(relayUrls);
        for await (const msg of source.req(filters, { signal: controller.signal })) {
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
    // `resumeEpoch` rebuilds the subscription after a real backgrounding. A
    // socket that died while the app was away usually reconnects and replays
    // stored subs on its own, but a HALF-open one — the OS dropped the
    // connection without telling the WebView — never fires a reconnect, and the
    // sub stays silently dead. A relay-sent CLOSED kills it just as
    // permanently: it breaks the `for await` above and is swallowed there.
    // Rebuilding is the only recovery for either, and with no `since` it costs
    // a handful of replaceables. `selfRelayKey` rebuilds it when the account's
    // relay set changes (e.g. NIP-65 adoption) so the standing REQ follows.
  }, [
    nostr,
    user?.pubkey,
    queryClient,
    eventStore,
    resumeEpoch,
    selfRelayKey,
    automaticSettingsSync,
    config.relayMetadata,
    updateConfig,
  ]);

  // The portable voice-server preference is synchronized in AppConfig, while
  // the voice runtime still reads its established localStorage key. Keep that
  // bridge current after login and whenever another device changes the value.
  useEffect(() => {
    setPreferredVoiceServer(config.preferredVoiceServer);
  }, [config.preferredVoiceServer]);

  // Background notification runtimes cannot read React state or decrypt the
  // settings document. Keep their localStorage mirror current when this device
  // edits the categories and when another client changes them.
  useEffect(() => {
    if (user?.pubkey) savePushPrefs(config.pushPrefs, user.pubkey);
  }, [config.pushPrefs, user?.pubkey]);

  // (Read-state hydration lives in ReadStateProvider, which owns the local map
  // and so can order it against its own debounced flush.)

  // ─── 1a. Quick-reaction frequency table ↔ its own document ────────────
  // Merge-hydrate (max count / most recent use per emoji) so the quick row on
  // a new device starts from the emoji the user actually reaches for. Safe to
  // run on every change: the merge is a no-op write when nothing moved, and —
  // as with the read state above — commutative, so the legacy copy in metadata
  // is simply folded in as a second source.
  useEffect(() => {
    if (!automaticSettingsSync || !user?.pubkey) return;
    if (reactionsDoc.doc?.frequentReactions) {
      hydrateFrequentReactions(user.pubkey, reactionsDoc.doc.frequentReactions);
    }
    if (metadata?.frequentReactions) {
      hydrateFrequentReactions(user.pubkey, metadata.frequentReactions);
    }
  }, [
    automaticSettingsSync,
    user?.pubkey,
    reactionsDoc.doc?.frequentReactions,
    metadata?.frequentReactions,
  ]);

  // …and push the other way, debounced, on a user-initiated reaction only
  // (`subscribeFrequentReactions` never fires for the hydrate above, so two
  // devices can't ping-pong the table between them).
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!automaticSettingsSync || !pubkey || !hasNip44Support) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeFrequentReactions((changed) => {
      if (changed !== pubkey) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // `update` merges the patch over the document last read from the
        // store. Publishing before one has been read would be merging over
        // `{}` — harmless here, since this document has exactly one field and
        // we are writing all of it, but the table itself would be replaced by
        // whatever this device happens to hold rather than merged with what
        // the others have. Waiting for the read costs one debounce window.
        if (!reactionsFetched.current) return;
        updateReactions({ frequentReactions: getFrequentReactions(pubkey) }).catch((err) =>
          console.warn("Frequent-reaction sync failed:", err),
        );
      }, FREQUENT_REACTIONS_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [automaticSettingsSync, user?.pubkey, hasNip44Support, updateReactions]);

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
      if (!replaceableIsNewerThanMetadata(event, current.blossomServerMetadata)) return current;
      const next = {
        ...current,
        blossomServerMetadata: {
          servers: blossomServerList.servers,
          updatedAt: event.created_at,
          eventId: event.id,
        },
      };
      markConfigSynced(next);
      return next;
    });
  }, [user?.pubkey, blossomServerList.event, blossomServerList.servers, updateConfig]);

  // ─── 1d. Standard search + DM relay lists → config ────────────────────
  // A signed empty replacement is an intentional clear, unlike a missing
  // result. The hooks expose the event separately so we can apply the former
  // and ignore the latter without ever treating a failed read as an empty list.
  useEffect(() => {
    const event = searchRelayList.event;
    if (!user?.pubkey
      || !event
      || searchRelayList.decryptFailed
      || searchRelaysAppliedEvent.current === event.id) return;
    searchRelaysAppliedEvent.current = event.id;
    updateConfig((current) => {
      const next = { ...current, searchRelays: searchRelayList.relays };
      markConfigSynced(next);
      return next;
    });
  }, [
    user?.pubkey,
    searchRelayList.event,
    searchRelayList.relays,
    searchRelayList.decryptFailed,
    updateConfig,
  ]);

  useEffect(() => {
    const event = dmRelayList.event;
    if (!user?.pubkey || !event || dmRelaysAppliedEvent.current === event.id) return;
    dmRelaysAppliedEvent.current = event.id;
    updateConfig((current) => {
      const next = { ...current, dmRelays: dmRelayList.relays };
      markConfigSynced(next);
      return next;
    });
  }, [user?.pubkey, dmRelayList.event, dmRelayList.relays, updateConfig]);

  // ─── 2. Ditto active profile theme fallback (first-time Armada users) ─
  useEffect(() => {
    if (!automaticSettingsSync || !user?.pubkey) return;
    if (dittoCheckedPubkey.current === user.pubkey) return;

    // Only adopt the Ditto theme if the user has no Armada theme yet: no
    // metadata document on disk AND still on the untouched default.
    const usingDefault = config.theme === "dark" && !config.customTheme;
    if (metadata || !usingDefault) {
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
  }, [
    automaticSettingsSync,
    user?.pubkey,
    metadata,
    config.theme,
    config.customTheme,
    nostr,
    applyCustomTheme,
  ]);

  return null;
}

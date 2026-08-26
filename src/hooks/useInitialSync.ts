import { useNostr } from "@nostrify/react";
import { useNostrLogin } from "@nostrify/react/login";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { accountDataRelays, selfStateRelays } from "@/contexts/AppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { useEventStore } from "@/hooks/useEventStore";
import {
  KIND_DM_RELAYS,
  parseDmRelays,
  type DmRelayListQuery,
} from "@/hooks/useDmRelayList";
import {
  KIND_BLOSSOM_SERVERS,
  type BlossomServerListQuery,
} from "@/hooks/useBlossomServerList";
import { listQueryKey, syncCommunityList } from "@/concord/hooks/useCommunityList";
import { liveEntries } from "@/concord/lib/communityList";
import { warmupCommunities } from "@/concord/lib/loginWarmup";
import {
  KIND_GROUP_CHAT,
  KIND_USER_GROUPS,
  type GroupRef,
} from "@/lib/nip29";
import {
  resolveGroupListRead,
  type UserGroupListQuery,
} from "@/hooks/useUserGroupList";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { groupListFoldKey, type PersistedGroupList } from "@/lib/nip29ServerCache";
import { MetadataDocSchema } from "@/lib/schemas";
import {
  SETTINGS_DTAGS,
  SETTINGS_KIND,
  hasMigratedKeys,
  settingsDTag,
  settingsDocForDTag,
} from "@/lib/settingsDocs";
import { parseBlossomServerList } from "@/lib/blossom";
import {
  newestCanonicalSelfList,
  readStoredCanonicalSelfLists,
  replaceableVersionIsNewer,
  replaceableIsNewerThanMetadata,
} from "@/lib/canonicalSelfList";
import {
  KIND_SEARCH_RELAYS,
  readSearchRelayList,
} from "@/lib/searchRelayList";
import type { SearchRelayListQuery } from "@/hooks/useSearchRelayList";
import { logSync } from "@/lib/syncLog";
import {
  decodeSettingsDoc,
  settingsDocQueryKey,
  type StoredSettingsDoc,
} from "@/hooks/useSettingsDoc";
import { decodeAndHydrateDmConversationIndex } from "@/hooks/useDmConversationIndexSync";
import { dmConversationIndexFilter } from "@/lib/dmConversationIndex";
import {
  discoverRelayList,
  KIND_RELAY_LIST,
  parseRelayList,
  queryExplicitRelays,
  queryExplicitRelaysWithStatus,
  relayListIsNewerThanMetadata,
  uniqueRelayUrls,
} from "@/lib/nip65";
import { markNotificationSettingsReady } from "@/lib/notificationSettingsAuthority";
import { RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-88 poll kind — polls render inline in the group timeline. */
const KIND_POLL = 1068;
/** Kinds shown in a group timeline (mirrors useGroupMessages). */
const TIMELINE_KINDS = [KIND_GROUP_CHAT, KIND_POLL];
/** How many messages to catch up per channel (mirrors useGroupMessages PAGE_SIZE). */
const PAGE_SIZE = 50;
/**
 * Time cap on catch-up history: only messages newer than this window are
 * eagerly synced at login. Anything older is reachable via normal scroll-up
 * pagination once a channel opens — the login gate shouldn't spend its budget
 * (or the caches) on ancient history.
 */
const CATCHUP_WINDOW_SECONDS = 7 * 24 * 60 * 60;
/** Cap on channels we eagerly catch up, so a user in dozens of groups isn't blocked forever. */
const MAX_CATCHUP_CHANNELS = 8;

/**
 * Overall timeout for the whole sync so a dead relay never traps the user.
 * Sized so the Concord warm-up (plane sweeps + per-channel history) usually fits;
 * if it doesn't, the gate lifts anyway and the in-chat sync status bar
 * carries the remaining progress.
 */
const SYNC_TIMEOUT_MS = 30_000;
/** Per-step network timeout. */
const STEP_TIMEOUT_MS = 8_000;
/**
 * Grace window for the fan-out reads this gate makes: once the first relay in a
 * batch answers, wait at most this long for the stragglers before moving on
 * with what we have. The step timeout above is the ceiling for a batch where
 * NOBODY answers; this is the ceiling for the far more common case where the
 * reachable relays reply in a few hundred ms and one dead relay would otherwise
 * hold the phase's "establishing …" line spinning until the full step timeout.
 * A relay still in flight is left neither answered nor failed, so the
 * absence-is-non-authoritative semantics the list reads rely on are preserved.
 */
const STEP_GRACE_MS = 1_500;

/** A phase of the post-login sync. */
export type SyncPhase =
  | "relays"
  | "settings"
  | "groups"
  | "messages"
  | "communities"
  | "channels"
  | "done";

/** One line in the boot-log terminal the SyncGate renders. */
export interface SyncLogLine {
  id: string;
  text: string;
  status?: string;
  tone?: "ok" | "info" | "warn";
}

export interface SyncState {
  phase: SyncPhase;
  /** Accumulating boot log, newest last. Drives the terminal feed. */
  log: SyncLogLine[];
  /** True once the sync has finished (or timed out). */
  done: boolean;
}

/** The line shown (in-progress, no status) when a phase begins. */
const PHASE_OPENING: Record<Exclude<SyncPhase, "done">, string> = {
  relays: "locating signed relay map",
  settings: "establishing secure channel",
  groups: "mounting channel directory",
  messages: "syncing recent transmissions",
  communities: "restoring encrypted communities",
  channels: "decrypting channel history",
};

/**
 * Runs the one-time post-login sync for `pubkey` and reports live progress:
 *
 *   1. Discover the user's signed NIP-65 relay map from bounded public indexes
 *      and the configured app relays, then use its read relays for this sync.
 *   2. Pull encrypted settings (NIP-78, kind 30078, d="armada/metadata") and
 *      seed the `["encrypted-settings", pubkey]` cache so NostrSync applies
 *      theme/relay config without a second fetch.
 *   3. Pull the kind 10009 group list (joined channels + servers) and seed the
 *      `["nip29","user-groups",pubkey]` cache.
 *   4. Catch up on the newest page of messages for each joined channel (capped),
 *      priming the same caches useGroupMessages reads so timelines render
 *      instantly once the gate lifts.
 *   5. Fetch + decrypt the Concord Community List (kind 33302 fragments), seed the
 *      ["concord","list"] cache, then WARM the communities themselves:
 *      register stream keys, sweep the control/guestbook planes, persist the
 *      control folds, and decrypt the newest page of every channel into the
 *      rumor store (see warmupCommunities) — so the gate never lifts onto a
 *      wall of empty rooms.
 *
 * Every step is best-effort and bounded by a timeout — the gate must never trap
 * a user behind a slow or unreachable relay. Returns `{ phase, label, done }`.
 * Pass `pubkey === undefined` to stay idle (done immediately).
 */
export function useInitialSync(pubkey: string | undefined): SyncState {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const { logins } = useNostrLogin();

  // Read at warm-up time through a ref, so the login list neither re-runs nor
  // re-keys the once-per-pubkey effect below.
  const soleAccountRef = useRef(true);
  soleAccountRef.current = logins.length <= 1;

  // The sequence runs once per pubkey, but relay discovery changes config in
  // the middle of that sequence. Read through a ref so later phases see the
  // adopted map without making the once-only effect restart.
  const configRef = useRef(config);
  configRef.current = config;

  // AppProvider's localStorage setter is recreated when config changes. Relay
  // discovery deliberately changes config in the middle of this sequence, so
  // depending on that setter would clean up the active run immediately after
  // `1 FOUND`; the once-per-pubkey guard would then refuse to restart it. Read
  // the latest setter through a ref just like config so adoption cannot cancel
  // the sync gate that is performing it.
  const updateConfigRef = useRef(updateConfig);
  updateConfigRef.current = updateConfig;

  const [state, setState] = useState<SyncState>({
    phase: "settings",
    log: [],
    done: pubkey === undefined,
  });

  // Guard so we run the sequence exactly once per fresh pubkey.
  const ranForRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!pubkey) {
      setState({ phase: "done", log: [], done: true });
      return;
    }
    // Wait until the signer for this pubkey is the active user (settings + the
    // group list need NIP-44 to decrypt). Until then, keep showing the spinner.
    if (!user || user.pubkey !== pubkey) return;
    if (ranForRef.current === pubkey) return;
    ranForRef.current = pubkey;

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setState({
        phase: "done",
        log: [
          { id: "auth", text: `authenticated ${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`, status: "OK", tone: "ok" },
          { id: "offline", text: "offline mode active", status: "MESH", tone: "info" },
        ],
        done: true,
      });
      return;
    }

    let cancelled = false;
    const overall = AbortSignal.timeout(SYNC_TIMEOUT_MS);
    const log: SyncLogLine[] = [];

    /** Open a phase: push an in-progress line, return its id. */
    const begin = (phase: Exclude<SyncPhase, "done">): string => {
      const id = `${phase}`;
      logSync("gate", `phase "${phase}" started`);
      log.push({ id, text: PHASE_OPENING[phase] });
      if (!cancelled) setState({ phase, log: [...log], done: false });
      return id;
    };

    /** Resolve a phase line with a status chip. */
    const resolve = (id: string, status: string, tone: SyncLogLine["tone"] = "ok") => {
      logSync("gate", `phase "${id}" resolved: ${status}`);
      const line = log.find((l) => l.id === id);
      if (line) {
        line.status = status;
        line.tone = tone;
      }
      if (!cancelled) setState((s) => ({ ...s, log: [...log] }));
    };

    /**
     * Remove a phase line entirely.
     *
     * A phase that found nothing has nothing to report: "mounting channel
     * directory — 0 channels" is not progress, it's noise, and it was
     * permanent noise for the common case. The NIP-29 group list is empty for
     * every Concord-only account (their channels are counted by the Concord
     * phases, under their own lines), which also zeroed the message catch-up
     * that reads from it — two dead zeros on every login. Drop the line at the
     * moment we learn the count instead; it stays visible, with its spinner,
     * for as long as the fetch is genuinely in flight.
     */
    const drop = (id: string) => {
      const i = log.findIndex((l) => l.id === id);
      if (i === -1) return;
      log.splice(i, 1);
      if (!cancelled) setState((s) => ({ ...s, log: [...log] }));
    };

    /** Update a phase line's status chip in place (live x/y progress). */
    const progress = (id: string, status: string) => {
      const line = log.find((l) => l.id === id);
      if (line && !line.tone) {
        line.status = status;
        if (!cancelled) setState((s) => ({ ...s, log: [...log] }));
      }
    };

    /** Append a standalone, already-resolved line. */
    const note = (id: string, text: string, status?: string, tone: SyncLogLine["tone"] = "info") => {
      log.push({ id, text, status, tone });
      if (!cancelled) setState((s) => ({ ...s, log: [...log] }));
    };

    const stepSignal = () => AbortSignal.any([overall, AbortSignal.timeout(STEP_TIMEOUT_MS)]);

    void (async () => {
      const shortPk = `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
      note("auth", `authenticated ${shortPk}`, "OK", "ok");

      // ── 1. Signed NIP-65 relay map ──────────────────────────────────────
      const rId = begin("relays");
      let accountRelays = accountDataRelays(configRef.current, pubkey);
      try {
        const pointerSignal = stepSignal();
        const [remoteDiscovery, storedPointers] = await Promise.all([
          discoverRelayList(
            nostr,
            pubkey,
            uniqueRelayUrls([
              ...accountRelays,
              ...configRef.current.appRelays,
              ...RELAY_LIST_DISCOVERY_RELAYS,
            ]),
            pointerSignal,
            { graceMs: STEP_GRACE_MS },
          ),
          readStoredCanonicalSelfLists(
            eventStore,
            pubkey,
            [KIND_RELAY_LIST],
            pointerSignal,
          ),
        ]);
        // Android's background service can verify and persist a newer pointer
        // while the WebView is stopped. Treat that local rumor as a first-class
        // canonical source; otherwise one stale reachable discovery relay can
        // switch this boot away from the relays that hold the newer state.
        const storedPointer = newestCanonicalSelfList(
          storedPointers.events.filter((event) => parseRelayList(event).length > 0),
          pubkey,
          KIND_RELAY_LIST,
        );
        const discovery = storedPointer && (
          !remoteDiscovery
          || replaceableVersionIsNewer(storedPointer, remoteDiscovery.event)
        )
          ? { event: storedPointer, relays: parseRelayList(storedPointer) }
          : remoteDiscovery;
        if (discovery) {
          const current = configRef.current;
          // A first discovery is the user's own signed declaration, so adopt
          // it automatically. Preserve a deliberate later toggle-off.
          const sameOwner = current.relayMetadata.pubkey === pubkey;
          const metadataIsNewer = !sameOwner
            || relayListIsNewerThanMetadata(discovery.event, current.relayMetadata);
          if (metadataIsNewer) {
            const next = {
              ...current,
              useUserRelays:
                metadataIsNewer && (!sameOwner || current.relayMetadata.updatedAt === 0)
                  ? true
                  : current.useUserRelays,
              relayMetadata: metadataIsNewer
                ? {
                    relays: discovery.relays,
                    updatedAt: discovery.event.created_at,
                    eventId: discovery.event.id,
                    pubkey,
                  }
                : current.relayMetadata,
            };
            configRef.current = next;
            updateConfigRef.current((live) => {
              const sameLiveOwner = live.relayMetadata.pubkey === pubkey;
              const liveMetadataIsNewer = !sameLiveOwner
                || relayListIsNewerThanMetadata(discovery.event, live.relayMetadata);
              if (!liveMetadataIsNewer) return live;
              return {
                ...live,
                useUserRelays:
                  liveMetadataIsNewer && (!sameLiveOwner || live.relayMetadata.updatedAt === 0)
                    ? true
                    : live.useUserRelays,
                relayMetadata: liveMetadataIsNewer ? next.relayMetadata : live.relayMetadata,
              };
            });
          }
          // Use the discovered write set for THIS bootstrap even if the user
          // had deliberately disabled it for ongoing traffic. That lets us
          // find the encrypted Armada preference that records that choice.
          accountRelays = uniqueRelayUrls([
            ...accountRelays,
            ...discovery.relays.filter((relay) => relay.write).map((relay) => relay.url),
          ]);
          resolve(rId, `${discovery.relays.length} FOUND`);
        } else {
          resolve(rId, "APP DEFAULTS", "info");
        }
      } catch {
        resolve(rId, "APP DEFAULTS", "warn");
      }
      if (cancelled) return;

      // Hydrate the standard portable service lists from the same discovered
      // account relays. Their normal queries may have already cached an empty
      // read against app defaults before NIP-65 discovery completed.
      let canonicalSearch: SearchRelayListQuery | undefined;
      let canonicalDm: DmRelayListQuery | undefined;
      let canonicalBlossom: (BlossomServerListQuery & { event: NostrRumor }) | undefined;
      try {
        const deadline = stepSignal();
        const [wireEvents, stored] = await Promise.all([
          queryExplicitRelays(
            nostr,
            accountRelays,
            [{
              kinds: [KIND_SEARCH_RELAYS, KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS],
              authors: [pubkey],
            }],
            deadline,
            { graceMs: STEP_GRACE_MS },
          ),
          readStoredCanonicalSelfLists(
            eventStore,
            pubkey,
            [KIND_SEARCH_RELAYS, KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS],
            deadline,
          ),
        ]);
        const cachedSearch = queryClient.getQueryData<SearchRelayListQuery>(
          ["search-relay-list", pubkey],
        );
        const cachedDm = queryClient.getQueryData<DmRelayListQuery>(["dm-relay-list", pubkey]);
        const cachedBlossom = queryClient.getQueryData<BlossomServerListQuery>(
          ["blossom-server-list", pubkey],
        );
        const candidates: NostrRumor[] = [
          ...wireEvents,
          ...stored.events,
          ...(cachedSearch?.event ? [cachedSearch.event] : []),
          ...(cachedDm?.event ? [cachedDm.event] : []),
          ...(cachedBlossom?.event ? [cachedBlossom.event] : []),
        ];
        const newest = (kind: number) => newestCanonicalSelfList(candidates, pubkey, kind);

        const searchEvent = newest(KIND_SEARCH_RELAYS);
        if (searchEvent) {
          canonicalSearch = {
            event: searchEvent,
            ...(await readSearchRelayList(searchEvent, user.signer)),
          };
          if (!canonicalSearch.decryptFailed) {
            queryClient.setQueryData(["search-relay-list", pubkey], canonicalSearch);
          }
        }

        const dmEvent = newest(KIND_DM_RELAYS);
        if (dmEvent) {
          canonicalDm = { event: dmEvent, relays: parseDmRelays(dmEvent) };
          queryClient.setQueryData(["dm-relay-list", pubkey], canonicalDm);
        }

        const blossomEvent = newest(KIND_BLOSSOM_SERVERS);
        if (blossomEvent) {
          canonicalBlossom = {
            event: blossomEvent,
            servers: parseBlossomServerList(blossomEvent),
          };
          queryClient.setQueryData(["blossom-server-list", pubkey], canonicalBlossom);
        }

        if (!cancelled && (canonicalSearch || canonicalDm || canonicalBlossom)) {
          const search = canonicalSearch && !canonicalSearch.decryptFailed
            ? canonicalSearch.relays
            : undefined;
          updateConfigRef.current((current) => ({
            ...current,
            ...(search ? { searchRelays: search } : {}),
            ...(canonicalDm ? { dmRelays: canonicalDm.relays } : {}),
            ...(canonicalBlossom
              && replaceableIsNewerThanMetadata(
                canonicalBlossom.event,
                current.blossomServerMetadata,
              )
              ? {
                  blossomServerMetadata: {
                    servers: canonicalBlossom.servers,
                    updatedAt: canonicalBlossom.event.created_at,
                    eventId: canonicalBlossom.event.id,
                  },
                }
              : {}),
          }));
        }
      } catch {
        // Best-effort; the owning hooks retry after the pool adopts NIP-65.
      }

      // ── 2. Encrypted settings ───────────────────────────────────────────
      const sId = begin("settings");
      let settingsFound = false;
      const automaticSettingsSync = configRef.current.automaticSettingsSync !== false;
      try {
        if (user.signer.nip44 && automaticSettingsSync) {
          // All six documents in one filter. No `limit`: it would cap the
          // whole filter rather than each `d`, so five of the six could come
          // back missing purely because the sixth answered first.
          const settingsFilter = {
            kinds: [SETTINGS_KIND],
            authors: [pubkey],
            "#d": SETTINGS_DTAGS,
          };
          const settingsRead = await queryExplicitRelaysWithStatus(
            nostr,
            accountRelays,
            [
              settingsFilter,
              // Unlike ordinary settings reads, the DM index must never widen
              // to queryExplicitRelays' general-pool fallback. With no explicit
              // self-state destination, leave it local and retry after relay
              // discovery rather than leaking the topic query to the pool.
              ...(accountRelays.length > 0 ? [dmConversationIndexFilter(pubkey)] : []),
            ],
            stepSignal(),
            { graceMs: STEP_GRACE_MS },
          );
          const events = settingsRead.events;
          const expectedSettingsRelays = uniqueRelayUrls(accountRelays);
          const settingsAbsenceAuthoritative = expectedSettingsRelays.length > 0
            && settingsRead.failed.length === 0
            && settingsRead.answered.length === expectedSettingsRelays.length;

          // Hydrate before SyncGate opens so a fresh device can draw restored
          // rows immediately. The helper caches successful decryptions, so the
          // standing owner will not prompt again for unchanged shard events.
          if (accountRelays.length > 0) {
            await decodeAndHydrateDmConversationIndex(events, user.signer, pubkey);
          }

          // Seed every split document straight into its own query cache. Their
          // events are already in ArmadaDB — `queryExplicitRelays` reads
          // through the batcher, which mirrors what it returns — so this is
          // purely to spare each hook the store round-trip on first render.
          const newestByDTag = new Map<string, NostrEvent>();
          for (const candidate of events) {
            const dTag = candidate.tags.find(([name]) => name === "d")?.[1];
            if (dTag === undefined) continue;
            const held = newestByDTag.get(dTag);
            if (
              !held
              || candidate.created_at > held.created_at
              || (candidate.created_at === held.created_at && candidate.id < held.id)
            ) {
              newestByDTag.set(dTag, candidate);
            }
          }
          for (const [dTag, candidate] of newestByDTag) {
            const name = settingsDocForDTag(dTag);
            if (!name || name === "metadata") continue; // metadata is seeded below
            const decoded = await decodeSettingsDoc(candidate, user.signer, pubkey, name);
            if (decoded && !cancelled) {
              queryClient.setQueryData(settingsDocQueryKey(name, pubkey), decoded);
            }
          }

          let legacyNotificationsPresent = false;
          const event = newestByDTag.get(settingsDTag("metadata"));
          if (event?.content) {
            const decrypted = await user.signer.nip44.decrypt(pubkey, event.content);
            const parsed = MetadataDocSchema.safeParse(JSON.parse(decrypted));
            if (parsed.success && !cancelled) {
              legacyNotificationsPresent = hasMigratedKeys(parsed.data, "notifications");
              // Fold this run's canonical relay reads (NIP-65 bootstrap, and
              // the standard 10007/10050/10063 lists) over the NIP-78 blob so
              // the seeded config already reflects them.
              const merged = {
                ...parsed.data,
                ...(canonicalSearch && !canonicalSearch.decryptFailed
                  ? { searchRelays: canonicalSearch.relays }
                  : {}),
                ...(canonicalDm ? { dmRelays: canonicalDm.relays } : {}),
                ...(canonicalBlossom
                  ? {
                      blossomServerMetadata: {
                        servers: canonicalBlossom.servers,
                        updatedAt: canonicalBlossom.event.created_at,
                        eventId: canonicalBlossom.event.id,
                      },
                    }
                  : {}),
              };
              // The event itself is already in ArmadaDB — `queryExplicitRelays`
              // reads through the batcher, which mirrors what it returns — so
              // the settings query would find it on its own. Seeding is for
              // `merged`, which folds this run's canonical relay reads over the
              // document and exists only in memory.
              queryClient.setQueryData<StoredSettingsDoc<"metadata">>(
                settingsDocQueryKey("metadata", pubkey),
                { event, doc: merged },
              );
              settingsFound = true;

              // Migration: kinds 10007/10050/10063 are the canonical home for
              // these lists as of this release, and they were dropped from the
              // synced config keys so the NIP-78 document no longer applies them.
              // Pre-migration clients stored them ONLY in that blob, so a fresh
              // device with no canonical event yet would otherwise revert to
              // defaults. Keep the blob's value alive locally; a later explicit
              // publish promotes it to the real list. Nothing is published here.
              const legacySearch = !canonicalSearch && Array.isArray(parsed.data.searchRelays)
                ? parsed.data.searchRelays
                : undefined;
              const legacyDm = !canonicalDm && Array.isArray(parsed.data.dmRelays)
                ? parsed.data.dmRelays
                : undefined;
              const legacyBlossom = !canonicalBlossom && parsed.data.blossomServerMetadata
                ? parsed.data.blossomServerMetadata
                : undefined;
              if (legacySearch || legacyDm || legacyBlossom) {
                updateConfigRef.current((current) => ({
                  ...current,
                  ...(legacySearch ? { searchRelays: legacySearch } : {}),
                  ...(legacyDm ? { dmRelays: legacyDm } : {}),
                  ...(legacyBlossom ? { blossomServerMetadata: legacyBlossom } : {}),
                }));
              }
            }
          }

          // An empty notifications document is authoritative only after every
          // declared self-state relay reached EOSE. If a split or legacy
          // document exists, useConfigDocSync marks readiness only after that
          // exact version has actually been folded into AppConfig.
          if (
            !cancelled
            && settingsAbsenceAuthoritative
            && !newestByDTag.has(settingsDTag("notifications"))
            && !legacyNotificationsPresent
          ) {
            markNotificationSettingsReady(pubkey);
          }
        }
      } catch {
        // Best-effort; fall through to the next step.
      }
      resolve(
        sId,
        automaticSettingsSync ? (settingsFound ? "RESTORED" : "DEFAULTS") : "OFF",
        settingsFound ? "ok" : "info",
      );
      if (cancelled) return;

      // ── 3. Group list (kind 10009) ──────────────────────────────────────
      const gId = begin("groups");
      let groups: GroupRef[] = [];
      try {
        const groupSignal = stepSignal();
        const [wireEvents, storedGroups] = await Promise.all([
          queryExplicitRelays(
            nostr,
            accountRelays,
            [{ kinds: [KIND_USER_GROUPS], authors: [pubkey], limit: 1 }],
            groupSignal,
            { graceMs: STEP_GRACE_MS },
          ),
          readStoredCanonicalSelfLists(
            eventStore,
            pubkey,
            [KIND_USER_GROUPS],
            groupSignal,
          ),
        ]);
        const queryKey = ["nip29", "user-groups", pubkey];
        const previous = queryClient.getQueryData<UserGroupListQuery>(queryKey);
        const persisted = await readFolded<PersistedGroupList>(groupListFoldKey(pubkey));
        const list = await resolveGroupListRead(
          [...wireEvents, ...storedGroups.events].filter((event) => event.pubkey === pubkey),
          user.signer,
          previous,
          persisted,
        );
        groups = list.groups;
        if (!cancelled && (list.event || previous || persisted)) {
          queryClient.setQueryData(queryKey, list);
          if (list.event && !list.decryptFailed) {
            void writeFolded(groupListFoldKey(pubkey), {
              event: list.event,
              groups: list.groups,
              servers: list.servers,
            } satisfies PersistedGroupList);
          }
        }
      } catch {
        // Best-effort.
      }
      if (groups.length > 0) {
        resolve(gId, `${groups.length} ${groups.length === 1 ? "channel" : "channels"}`);
      } else {
        drop(gId);
      }
      if (cancelled) return;

      // ── 4. Warm the store with recent messages for joined channels ──────
      // Skipped outright with no NIP-29 channels to catch up on — there is
      // nothing to sync and nothing worth showing.
      const channels = groups.slice(0, MAX_CATCHUP_CHANNELS);
      if (channels.length > 0) {
        const mId = begin("messages");
        let messageCount = 0;
        const since = Math.floor(Date.now() / 1000) - CATCHUP_WINDOW_SECONDS;
        await Promise.all(
          channels.map(async ({ id, relay }) => {
            try {
              const events = await nostr.relay(relay).query(
                [{ kinds: TIMELINE_KINDS, "#h": [id], since, limit: PAGE_SIZE }],
                { signal: stepSignal() },
              );
              if (cancelled) return;
              messageCount += events.length;
              // The relay() wrapper mirrors these into the shared IndexedDB
              // store — the single layer every timeline and unread scan
              // hydrates from. No cache seeding: hooks read the store.
            } catch {
              // Best-effort per channel.
            }
          }),
        );
        resolve(mId, `${messageCount} cached`);
      }
      if (cancelled) return;

      // ── 5. Concord: seed the community list. ──────────────────────────
      let concordLive: ReturnType<typeof liveEntries> = [];
      if (user.signer.nip44) {
        const vId = begin("communities");
        try {
          // The login gate is the natural seeding moment for an account
          // migrating off the retired single-event list: pass the self-state
          // write set so a confirmed-empty read can seed §8 from local state.
          const listData = await syncCommunityList(
            nostr,
            user,
            queryClient,
            stepSignal(),
            selfStateRelays(configRef.current, pubkey),
          );
          logSync(
            "gate",
            `concord list fetched: event=${listData.event ? listData.event.id.slice(0, 8) : "none"} entries=${listData.list.entries.length} live=${liveEntries(listData.list).length} decryptFailed=${Boolean(listData.decryptFailed)}`,
          );
          if (!cancelled && !listData.decryptFailed) {
            queryClient.setQueryData(listQueryKey(pubkey), listData);
            concordLive = liveEntries(listData.list);
          }
        } catch (err) {
          // Best-effort; never block login on Concord.
          logSync("gate", `concord list fetch FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (concordLive.length > 0) {
          resolve(vId, `${concordLive.length} ${concordLive.length === 1 ? "community" : "communities"}`);
        } else {
          drop(vId);
        }
      }
      if (cancelled) return;

      // ── 6. Concord warm-up: planes, folds, newest channel pages. ──────
      // This is what makes the gate honest — without it the app shows through
      // with rail icons but hollow, empty rooms. Raced against the overall
      // budget: if it can't finish in time the gate lifts anyway and the
      // warm-up keeps running, visible in the in-chat sync status bar.
      if (concordLive.length > 0) {
        const hId = begin("channels");
        const warmup = warmupCommunities(nostr, concordLive, {
          signal: overall,
          onProgress: (done, total) => progress(hId, `${done}/${total}`),
          // With a second account logged in, "retired epoch" cannot be judged
          // from this account's list entry alone — see the opt's docstring.
          pruneSnapshots: soleAccountRef.current,
        });
        // The abandoned branch of the race must never surface as unhandled.
        warmup.catch(() => undefined);
        const warm = await Promise.race([
          warmup,
          new Promise<undefined>((settle) => {
            if (overall.aborted) settle(undefined);
            else overall.addEventListener("abort", () => settle(undefined), { once: true });
          }),
        ]);
        if (warm) {
          resolve(hId, `${warm.messages} decrypted`);
        } else {
          resolve(hId, "CONTINUING", "warn");
        }
      }
      if (cancelled) return;

      // NOTE: we deliberately do NOT write the settings sync watermark here.
      // NostrSync owns applying the fetched settings (theme/relay config) into
      // AppConfig and only then records the watermark; writing it now would make
      // NostrSync's timestamp guard skip the very settings we just primed. The
      // "don't re-gate on reload" behavior is handled by useFreshLogin instead.
      note("ready", "all systems nominal", "READY", "ok");
      if (!cancelled) setState((s) => ({ ...s, phase: "done", done: true }));
    })();

    return () => {
      cancelled = true;
    };
  }, [pubkey, user, nostr, queryClient, eventStore]);

  return state;
}

import { useNostr } from "@nostrify/react";
import { useNostrLogin } from "@nostrify/react/login";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { accountDataRelays } from "@/contexts/AppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import {
  KIND_DM_RELAYS,
  parseDmRelays,
  type DmRelayListQuery,
} from "@/hooks/useDmRelayList";
import {
  KIND_BLOSSOM_SERVERS,
  type BlossomServerListQuery,
} from "@/hooks/useBlossomServerList";
import {
  CONCORD_ENABLED,
  CONCORD_LIST_D_TAG,
  CONCORD_LIST_KIND,
  type ConcordList,
} from "@/concord-v1/lib/concord";
import { channelPseudonym } from "@/concord-v1/lib/derive";
import { acceptInvite, type CommunityInvite } from "@/concord-v1/lib/invite";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_MESSAGE } from "@/concord-v1/lib/kinds";
import type { Channel, Community } from "@/concord-v1/lib/types";
import { listQueryKey, syncCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { liveEntries } from "@/concord-v2/lib/communityList";
import { warmupCommunities2 } from "@/concord-v2/lib/loginWarmup";
import {
  KIND_GROUP_CHAT,
  KIND_USER_GROUPS,
  parseGroupListTags,
  type GroupRef,
} from "@/lib/nip29";
import { EncryptedSettingsSchema } from "@/lib/schemas";
import { parseBlossomServerList } from "@/lib/blossom";
import {
  KIND_SEARCH_RELAYS,
  readSearchRelayList,
} from "@/lib/searchRelayList";
import type { SearchRelayListQuery } from "@/hooks/useSearchRelayList";
import { logSync } from "@/lib/syncLog";
import type { SettingsRead } from "@/hooks/useEncryptedSettings";
import {
  discoverRelayList,
  queryExplicitRelays,
  uniqueRelayUrls,
} from "@/lib/nip65";
import { RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";

import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-78 application-data kind (Armada's encrypted settings). */
const SETTINGS_KIND = 30078;
/** `d` tag identifying Armada's settings event. */
const SETTINGS_D = "armada/metadata";
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
/** Cap on Concord communities we eagerly catch up. */
const MAX_CATCHUP_COMMUNITIES = 6;

/**
 * Overall timeout for the whole sync so a dead relay never traps the user.
 * Sized so the V2 warm-up (plane sweeps + per-channel history) usually fits;
 * if it doesn't, the gate lifts anyway and the in-chat sync status bar
 * carries the remaining progress.
 */
const SYNC_TIMEOUT_MS = 30_000;
/** Per-step network timeout. */
const STEP_TIMEOUT_MS = 8_000;

/** A phase of the post-login sync. */
export type SyncPhase =
  | "relays"
  | "settings"
  | "groups"
  | "messages"
  | "concord"
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
  concord: "decrypting community vault",
  communities: "restoring encrypted communities",
  channels: "decrypting channel history",
};

/** Held epoch keys for a channel, newest-first (mirrors useConcordChannel). */
function readEpochKeys(channel: Channel): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length ? channel.epochKeys : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/** The `#z` pseudonyms to query for a channel (one per held epoch). */
function channelPseudonyms(channel: Channel): string[] {
  return readEpochKeys(channel).map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));
}

/**
 * Fetch one Concord channel's newest sealed events from the community's
 * relays. The relay() wrapper mirrors every returned outer into the shared
 * IndexedDB store — which is all catch-up needs: the channel hooks (and the
 * V1 unread scan) hydrate from the store and decrypt on demand. Best-effort:
 * a relay miss is skipped, never thrown past the caller.
 */
async function catchUpConcordChannel(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  channel: Channel,
  since: number,
  signal: AbortSignal,
): Promise<void> {
  const zs = channelPseudonyms(channel);
  await Promise.all(
    community.relays.map((url) =>
      nostr
        .relay(url)
        .query(
          [{ kinds: [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_DELETE], "#z": zs, since, limit: 500 }],
          { signal },
        )
        .catch(() => [] as NostrEvent[]),
    ),
  );
}

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
 *   4. Catch up on Concord (encrypted communities): decrypt the membership list,
 *      rehydrate each community, and decrypt its channels' newest messages,
 *      priming the ["concord","channel",…] caches useConcordChannelMessages reads.
 *   5. Fetch + decrypt the Concord V2 Community List (kind 13302), seed the
 *      ["concord2","list"] cache, then WARM the communities themselves:
 *      register stream keys, sweep the control/guestbook planes, persist the
 *      control folds, and decrypt the newest page of every channel into the
 *      rumor store (see warmupCommunities2) — so the gate never lifts onto a
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
      let bootstrapAppRelays: string[] = [];
      try {
        const discovery = await discoverRelayList(
          nostr,
          pubkey,
          uniqueRelayUrls([
            ...accountRelays,
            ...configRef.current.appRelays,
            ...RELAY_LIST_DISCOVERY_RELAYS,
          ]),
          stepSignal(),
        );
        if (discovery) {
          const current = configRef.current;
          // A first discovery is the user's own signed declaration, so adopt
          // it automatically. Preserve a deliberate later toggle-off.
          const sameOwner = current.relayMetadata.pubkey === pubkey;
          const metadataIsNewer = !sameOwner
            || discovery.event.created_at > current.relayMetadata.updatedAt;
          const discoveredUrls = discovery.relays.map((relay) => relay.url);
          if (metadataIsNewer || current.appRelays.length === 0) {
            const next = {
              ...current,
              appRelays: current.appRelays.length === 0
                ? discoveredUrls
                : current.appRelays,
              useUserRelays:
                metadataIsNewer && (!sameOwner || current.relayMetadata.updatedAt === 0)
                  ? true
                  : current.useUserRelays,
              relayMetadata: metadataIsNewer
                ? {
                    relays: discovery.relays,
                    updatedAt: discovery.event.created_at,
                    pubkey,
                  }
                : current.relayMetadata,
            };
            configRef.current = next;
            bootstrapAppRelays = current.appRelays.length === 0 ? next.appRelays : [];
            updateConfigRef.current((live) => {
              const sameLiveOwner = live.relayMetadata.pubkey === pubkey;
              const liveMetadataIsNewer = !sameLiveOwner
                || discovery.event.created_at > live.relayMetadata.updatedAt;
              if (!liveMetadataIsNewer && live.appRelays.length > 0) return live;
              return {
                ...live,
                appRelays: live.appRelays.length === 0 ? discoveredUrls : live.appRelays,
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
      let canonicalBlossom: (BlossomServerListQuery & { event: NostrEvent }) | undefined;
      try {
        const events = await queryExplicitRelays(
          nostr,
          accountRelays,
          [{
            kinds: [KIND_SEARCH_RELAYS, KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS],
            authors: [pubkey],
          }],
          stepSignal(),
        );
        const newest = (kind: number) => events
          .filter((event) => event.kind === kind)
          .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];

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
              && canonicalBlossom.event.created_at > current.blossomServerMetadata.updatedAt
              ? {
                  blossomServerMetadata: {
                    servers: canonicalBlossom.servers,
                    updatedAt: canonicalBlossom.event.created_at,
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
      try {
        if (user.signer.nip44) {
          const events = await queryExplicitRelays(
            nostr,
            accountRelays,
            [{ kinds: [SETTINGS_KIND], authors: [pubkey], "#d": [SETTINGS_D], limit: 1 }],
            stepSignal(),
          );
          const event = events.sort((a, b) => b.created_at - a.created_at)[0];
          if (event?.content) {
            const decrypted = await user.signer.nip44.decrypt(pubkey, event.content);
            const parsed = EncryptedSettingsSchema.safeParse(JSON.parse(decrypted));
            if (parsed.success && !cancelled) {
              // Fold this run's canonical relay reads (NIP-65 bootstrap, and
              // the standard 10007/10050/10063 lists) over the NIP-78 blob so
              // the seeded config already reflects them.
              const merged = {
                ...parsed.data,
                ...(bootstrapAppRelays.length > 0 && parsed.data.appRelays?.length === 0
                  ? { appRelays: bootstrapAppRelays }
                  : {}),
                ...(canonicalSearch && !canonicalSearch.decryptFailed
                  ? { searchRelays: canonicalSearch.relays }
                  : {}),
                ...(canonicalDm ? { dmRelays: canonicalDm.relays } : {}),
                ...(canonicalBlossom
                  ? {
                      blossomServerMetadata: {
                        servers: canonicalBlossom.servers,
                        updatedAt: canonicalBlossom.event.created_at,
                      },
                    }
                  : {}),
              };
              // Seeded in the shape useEncryptedSettings stores: this WAS a
              // relay read, so it counts as a confirmed one and NostrSync may
              // merge over it. (The settings watermark is deliberately not
              // written here — see the note further down — so NostrSync still
              // applies these to config.)
              queryClient.setQueryData<SettingsRead>(["encrypted-settings", pubkey], {
                settings: merged,
                source: "remote",
                complete: true,
              });
              settingsFound = true;

              // Migration: kinds 10007/10050/10063 are the canonical home for
              // these lists as of this release, and they were dropped from
              // SYNCED_CONFIG_KEYS so the NIP-78 blob no longer applies them.
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
        }
      } catch {
        // Best-effort; fall through to the next step.
      }
      resolve(sId, settingsFound ? "RESTORED" : "DEFAULTS", settingsFound ? "ok" : "info");
      if (cancelled) return;

      // ── 3. Group list (kind 10009) ──────────────────────────────────────
      const gId = begin("groups");
      let groups: GroupRef[] = [];
      try {
        const events = await queryExplicitRelays(
          nostr,
          accountRelays,
          [{ kinds: [KIND_USER_GROUPS], authors: [pubkey], limit: 1 }],
          stepSignal(),
        );
        const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
        if (latest) {
          const tags = [...latest.tags];
          if (latest.content && user.signer.nip44) {
            try {
              const decrypted = await user.signer.nip44.decrypt(pubkey, latest.content);
              const privateTags = JSON.parse(decrypted);
              if (Array.isArray(privateTags)) {
                for (const t of privateTags) if (Array.isArray(t)) tags.push(t as string[]);
              }
            } catch {
              // Public-only fallback.
            }
          }
          const list = parseGroupListTags(tags);
          groups = list.groups;
          if (!cancelled) {
            queryClient.setQueryData(["nip29", "user-groups", pubkey], {
              event: latest,
              groups: list.groups,
              servers: list.servers,
            });
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

      // ── 4. Warm the store with recent Concord (V1) traffic ──────────────
      // Concord membership is a self-encrypted list (kind 30078, d=armada/concord)
      // that carries the room KEYS. Rehydrate each community and pull its
      // channels' newest sealed events — the relay() wrapper mirrors them into
      // the shared store, which the channel hooks decrypt on demand.
      if (CONCORD_ENABLED && user.signer.nip44) {
        const cId = begin("concord");
        let communityCount = 0;
        try {
          const listEvents = await nostr.query(
            [{ kinds: [CONCORD_LIST_KIND], authors: [pubkey], "#d": [CONCORD_LIST_D_TAG], limit: 1 }],
            { signal: stepSignal() },
          );
          const latest = listEvents.sort((a, b) => b.created_at - a.created_at)[0];
          let list: ConcordList | undefined;
          if (latest?.content) {
            const decrypted = await user.signer.nip44.decrypt(pubkey, latest.content);
            const parsed = JSON.parse(decrypted) as Partial<ConcordList>;
            list = {
              entries: Array.isArray(parsed.entries) ? parsed.entries : [],
              tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
            };
            // Seed the membership list so the Concord UI opens instantly.
            if (!cancelled) {
              queryClient.setQueryData(["concord", "list", pubkey], { event: latest, list });
            }
          }

          // Rehydrate communities and catch up each channel's messages.
          const communities: Community[] = [];
          for (const entry of list?.entries.slice(0, MAX_CATCHUP_COMMUNITIES) ?? []) {
            const invite = entry.current.keys.invite as CommunityInvite | undefined;
            if (!invite) continue;
            try {
              communities.push(acceptInvite(invite));
            } catch {
              // Unreadable bundle — skip.
            }
          }
          communityCount = communities.length;

          const since = Math.floor(Date.now() / 1000) - CATCHUP_WINDOW_SECONDS;
          await Promise.all(
            communities.flatMap((community) =>
              community.channels.map((channel) =>
                catchUpConcordChannel(nostr, community, channel, since, stepSignal()).catch(
                  () => {
                    // Best-effort per channel.
                  },
                ),
              ),
            ),
          );
        } catch {
          // Best-effort; never block login on Concord.
        }
        if (communityCount > 0) {
          resolve(cId, `${communityCount} ${communityCount === 1 ? "community" : "communities"}`);
        } else {
          drop(cId);
        }
      }
      if (cancelled) return;

      // ── 5. Concord V2: seed the community list. ──────────────────────────
      let v2Live: ReturnType<typeof liveEntries> = [];
      if (user.signer.nip44) {
        const vId = begin("communities");
        try {
          const listData = await syncCommunityList2(nostr, user, queryClient, stepSignal());
          logSync(
            "gate",
            `v2 list fetched: event=${listData.event ? listData.event.id.slice(0, 8) : "none"} entries=${listData.list.entries.length} live=${liveEntries(listData.list).length} decryptFailed=${Boolean(listData.decryptFailed)}`,
          );
          if (!cancelled && !listData.decryptFailed) {
            queryClient.setQueryData(listQueryKey(pubkey), listData);
            v2Live = liveEntries(listData.list);
          }
        } catch (err) {
          // Best-effort; never block login on Concord.
          logSync("gate", `v2 list fetch FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (v2Live.length > 0) {
          resolve(vId, `${v2Live.length} ${v2Live.length === 1 ? "community" : "communities"}`);
        } else {
          drop(vId);
        }
      }
      if (cancelled) return;

      // ── 6. Concord V2 warm-up: planes, folds, newest channel pages. ──────
      // This is what makes the gate honest — without it the app shows through
      // with rail icons but hollow, empty rooms. Raced against the overall
      // budget: if it can't finish in time the gate lifts anyway and the
      // warm-up keeps running, visible in the in-chat sync status bar.
      if (v2Live.length > 0) {
        const hId = begin("channels");
        const warmup = warmupCommunities2(nostr, v2Live, {
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
  }, [pubkey, user, nostr, queryClient]);

  return state;
}

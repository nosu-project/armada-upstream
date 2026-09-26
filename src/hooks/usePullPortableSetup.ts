import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { accountDataRelays, type AppConfig } from "@/contexts/AppContext";
import {
  listQueryKey,
  type FragSet,
  type ListData,
  type PersistedList,
} from "@/concord/hooks/useCommunityList";
import {
  decodeInviteListEvents,
  inviteListFoldKey,
  inviteListKey,
  readPersistedInviteList,
  type PersistedInviteList,
} from "@/concord/hooks/useInvites";
import {
  communityListFoldKey,
  mergeCommunityLists,
} from "@/concord/lib/communityList";
import { KIND_INVITE_LIST } from "@/concord/lib/kinds";
import { mergeInviteLists, type InviteList } from "@/concord/lib/invite";
import { useAppContext } from "@/hooks/useAppContext";
import {
  KIND_BLOSSOM_SERVERS,
  type BlossomServerListQuery,
} from "@/hooks/useBlossomServerList";
import { markConfigSynced } from "@/hooks/useConfigDocSync";
import {
  KIND_DM_RELAYS,
  parseDmRelays,
  type DmRelayListQuery,
} from "@/hooks/useDmRelayList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNip65RelaySetup } from "@/hooks/useNip65RelaySetup";
import {
  fetchPortableWireState,
  newestPortableAddressableEvents,
} from "@/hooks/usePublishPortableSetup";
import {
  decodeDmConversationIndexEvents,
  dmConversationIndexSyncQueryKey,
  type DecodedDmConversationIndex,
} from "@/hooks/useDmConversationIndexSync";
import { hydrateDmConversationIndexShards } from "@/hooks/useDmConversationIndex";
import {
  decodeFavoriteGifEvents,
  favoriteGifsSyncQueryKey,
} from "@/hooks/useFavoriteGifsSync";
import {
  FAVORITE_GIFS_D_PREFIX,
  FAVORITE_GIFS_EVENT_TAG,
  hydrateFavoriteGifShards,
} from "@/hooks/useFavoriteGifs";
import {
  settingsDocFilter,
  settingsDocQueryKey,
} from "@/hooks/useSettingsDoc";
import {
  resolveGroupListRead,
  type UserGroupListQuery,
} from "@/hooks/useUserGroupList";
import { parseBlossomServerList } from "@/lib/blossom";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { KIND_USER_GROUPS } from "@/lib/nip29";
import { groupListFoldKey, type PersistedGroupList } from "@/lib/nip29ServerCache";
import {
  parseRelayList,
  queryExplicitRelays,
  uniqueRelayUrls,
} from "@/lib/nip65";
import {
  KIND_SEARCH_RELAYS,
  readSearchRelayList,
} from "@/lib/searchRelayList";
import {
  SETTINGS_DOC_NAMES,
  SETTINGS_KIND,
  parseSettingsDoc,
  settingsDTag,
  type SettingsDocName,
} from "@/lib/settingsDocs";
import { docToConfigPatch, CONFIG_KEYS_BY_DOC, type ConfigDocName } from "@/lib/syncedConfig";
import {
  DM_CONVERSATIONS_EVENT_TAG,
  newestDmConversationIndexEvents,
} from "@/lib/dmConversationIndex";
import { SELF_SYNC_TOPIC_TAGS } from "@/lib/selfSyncKinds";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { SearchRelayListQuery } from "@/hooks/useSearchRelayList";
import type { MetadataDoc } from "@/lib/schemas";

const PULL_TIMEOUT_MS = 8_000;

export interface PortableSetupPullResult {
  /** Number of distinct portable records found, including the NIP-65 map. */
  records: number;
  /** Explicit account relays queried for the portable records. */
  sources: number;
  /** Whether the pulled metadata document carried the Voice-page server. */
  voiceServer: boolean;
  /**
   * True when the signer cannot decrypt, so the private records (the 10009
   * server list, the 10007 search list and every settings document) were not
   * read at all. The public ones still were.
   */
  publicOnly: boolean;
}

/** One settings document as pulled: the event, its plaintext, and which it is. */
interface PulledSettingsDoc {
  name: SettingsDocName;
  event: NostrEvent;
  doc: Record<string, unknown>;
}

function newest(
  events: NostrEvent[],
  pubkey: string,
  kind: number,
): NostrEvent | undefined {
  return events
    .filter((event) => event.pubkey === pubkey && event.kind === kind)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

export function nip01VersionIsNewer(
  candidate: Pick<NostrEvent, "created_at" | "id">,
  current: Pick<NostrEvent, "created_at" | "id"> | undefined,
): boolean {
  return !current
    || candidate.created_at > current.created_at
    || (candidate.created_at === current.created_at && candidate.id < current.id);
}

function knownWriteRelays(config: AppConfig, pubkey: string): string[] {
  if (config.relayMetadata.pubkey !== pubkey) return [];
  return config.relayMetadata.relays
    .filter((relay) => relay.write)
    .map((relay) => relay.url);
}

/** Let a macrotask scheduled during this turn run before we continue. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Explicitly re-read the account's portable setup from its NIP-65 relays.
 *
 * This is the read half of {@link usePublishPortableSetup}, and exists because
 * the automatic path is not always available: a device with automatic settings
 * sync off applies nothing on its own, and a device whose relay set has drifted
 * may never have asked the relays that hold the newest documents.
 *
 * Three rules, all of which the tests hold to:
 *
 *  • It NEVER signs or publishes. Everything here is a read plus local state.
 *  • It is atomic in the records it can't half-apply: every private record is
 *    decrypted before anything is written, so a signer that refuses midway
 *    leaves the client exactly as it was.
 *  • An empty read clears nothing. A record no relay returned is left alone,
 *    because an empty answer is indistinguishable from a failed one.
 */
export function usePullPortableSetup() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const { discover, adopt } = useNip65RelaySetup();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const [isPending, setIsPending] = useState(false);

  const pull = useCallback(async (): Promise<PortableSetupPullResult> => {
    if (!user) throw new Error("Not logged in");
    const { signer } = user;
    // A signer without NIP-44 can still restore the records that carry no
    // ciphertext. Refusing the whole pull would cost such an account its relay
    // map and its DM/media lists over documents it was never going to read.
    const canDecrypt = Boolean(signer.nip44);

    setIsPending(true);
    try {
      const store = await eventStore;
      let localCanonical: NostrEvent[] = [];
      try {
        localCanonical = (await store.query([{
          kinds: [10002, KIND_SEARCH_RELAYS, KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS],
          authors: [user.pubkey],
        }])) as NostrEvent[];
      } catch {
        // The explicit pull still works from wire-only state when ArmadaDB is
        // temporarily unavailable.
      }
      const currentWriteRelays = knownWriteRelays(config, user.pubkey);
      const localRelayEvent = newest(localCanonical, user.pubkey, 10002);
      const localRelayWriteRelays = localRelayEvent
        ? parseRelayList(localRelayEvent)
            .filter((relay) => relay.write)
            .map((relay) => relay.url)
        : [];
      const discovered = await discover([...currentWriteRelays, ...localRelayWriteRelays]);
      const pointerEvent = newest(
        [
          ...localCanonical.filter((event) => event.kind === 10002),
          ...(discovered ? [discovered.event] : []),
        ],
        user.pubkey,
        10002,
      );
      const pointerRelays = pointerEvent ? parseRelayList(pointerEvent) : [];
      const discovery = pointerEvent && pointerRelays.length > 0
        ? { event: pointerEvent, relays: pointerRelays }
        : discovered;
      const discoveredWriteRelays = discovery?.relays
        .filter((relay) => relay.write)
        .map((relay) => relay.url) ?? [];
      const sources = uniqueRelayUrls([
        ...accountDataRelays(config, user.pubkey),
        ...currentWriteRelays,
        ...discoveredWriteRelays,
      ]);
      if (sources.length === 0) {
        throw new Error("No NIP-65 write relays are available to pull from");
      }

      let communityEvents: NostrEvent[] = [];
      let communitySet: FragSet | null = null;
      let events: NostrEvent[];
      if (canDecrypt) {
        const wire = await fetchPortableWireState(
          nostr,
          user,
          sources,
          AbortSignal.timeout(PULL_TIMEOUT_MS),
        );
        events = wire.events;
        communityEvents = wire.communityEvents;
        communitySet = wire.communitySet;
      } else {
        const filters: NostrFilter[] = [{
          kinds: [KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS],
          authors: [user.pubkey],
        }];
        events = await queryExplicitRelays(
          nostr,
          sources,
          filters,
          AbortSignal.timeout(PULL_TIMEOUT_MS),
        );
      }

      const canonicalCandidates = [...events, ...localCanonical];
      const groupEvent = canDecrypt ? newest(events, user.pubkey, KIND_USER_GROUPS) : undefined;
      const searchEvent = canDecrypt
        ? newest(canonicalCandidates, user.pubkey, KIND_SEARCH_RELAYS)
        : undefined;
      const dmEvent = newest(canonicalCandidates, user.pubkey, KIND_DM_RELAYS);
      const blossomEvent = newest(canonicalCandidates, user.pubkey, KIND_BLOSSOM_SERVERS);

      const inviteEvents = canDecrypt
        ? events.filter((event) => event.kind === KIND_INVITE_LIST && event.pubkey === user.pubkey)
        : [];
      const inviteRead = inviteEvents.length > 0
        ? await decodeInviteListEvents(inviteEvents, user)
        : undefined;
      const persistedInvites = canDecrypt
        ? await readPersistedInviteList(user.pubkey)
        : undefined;
      if (inviteRead?.unreadable) {
        throw new Error("Your creator invite records could not be decrypted; nothing was restored");
      }

      const topicEditions = canDecrypt
        ? events.filter((event) => event.tags.some(
            ([name, value]) => name === "t" && SELF_SYNC_TOPIC_TAGS.includes(value),
          ))
        : [];
      const topicHeads = newestPortableAddressableEvents(topicEditions, SETTINGS_KIND);
      const dmIndexEvents = topicEditions.filter((event) => event.tags.some(
        ([name, value]) => name === "t" && value === DM_CONVERSATIONS_EVENT_TAG,
      ));
      let decodedDmIndex: DecodedDmConversationIndex | undefined;
      if (dmIndexEvents.length > 0) {
        decodedDmIndex = await decodeDmConversationIndexEvents(
          dmIndexEvents,
          signer,
          user.pubkey,
        );
        if (decodedDmIndex.heads.size !== newestDmConversationIndexEvents(dmIndexEvents, user.pubkey).length) {
          throw new Error("Your DM conversation index could not be decrypted completely; nothing was restored");
        }
      }
      const favoriteGifEvents = topicEditions.filter((event) => event.tags.some(
        ([name, value]) => name === "t" && value === FAVORITE_GIFS_EVENT_TAG,
      ));
      const decodedFavoriteGifs = favoriteGifEvents.length > 0
        ? await decodeFavoriteGifEvents(
            user.pubkey,
            (pubkey, content) => signer.nip44!.decrypt(pubkey, content),
            favoriteGifEvents,
          )
        : undefined;
      const expectedFavoriteCoordinates = new Set(
        favoriteGifEvents
          .map((event) => event.tags.find(([name]) => name === "d")?.[1])
          .filter((d): d is string => Boolean(d?.startsWith(FAVORITE_GIFS_D_PREFIX))),
      ).size;
      if (decodedFavoriteGifs && decodedFavoriteGifs.ownEvents.size !== expectedFavoriteCoordinates) {
        throw new Error("Your GIF favorites could not be decrypted completely; nothing was restored");
      }

      // Decode every private record before changing any cache. A failed signer
      // request must not leave the client with a half-applied setup.
      let groupList: UserGroupListQuery | undefined;
      if (groupEvent) {
        const previous = queryClient.getQueryData<UserGroupListQuery>([
          "nip29", "user-groups", user.pubkey,
        ]);
        const persisted = await readFolded<PersistedGroupList>(groupListFoldKey(user.pubkey));
        groupList = await resolveGroupListRead(
          events.filter((event) =>
            event.kind === KIND_USER_GROUPS && event.pubkey === user.pubkey),
          signer,
          previous,
          persisted,
        );
        if (groupList.decryptFailed) {
          throw new Error("Your server list could not be decrypted; nothing was restored");
        }
      }

      const searchList = searchEvent
        ? await readSearchRelayList(searchEvent, signer)
        : undefined;
      if (searchList?.decryptFailed) {
        throw new Error("Your search-relay list could not be decrypted; nothing was restored");
      }

      // The settings documents. ArmadaDB is the model for these (see
      // `useSettingsDoc`), so a relay copy that is not strictly newer than what
      // is already on disk is dropped rather than applied — the store would
      // refuse the write anyway, and seeding the query cache with it would
      // regress a version this device has already applied.
      const storedVersions = new Map<SettingsDocName, Pick<NostrEvent, "created_at" | "id">>();
      if (canDecrypt) {
        for (const name of SETTINGS_DOC_NAMES) {
          try {
            for (const rumor of await store.query([settingsDocFilter(user.pubkey, name)])) {
              const held = storedVersions.get(name);
              if (nip01VersionIsNewer(rumor, held)) {
                storedVersions.set(name, rumor);
              }
            }
          } catch {
            // Store unavailable; treat as "nothing on disk".
          }
        }
      }

      const newestByDTag = new Map<string, NostrEvent>();
      for (const candidate of events) {
        if (candidate.kind !== SETTINGS_KIND || candidate.pubkey !== user.pubkey) continue;
        const dTag = candidate.tags.find(([name]) => name === "d")?.[1];
        if (dTag === undefined) continue;
        const held = newestByDTag.get(dTag);
        if (!held
          || candidate.created_at > held.created_at
          || (candidate.created_at === held.created_at && candidate.id < held.id)) {
          newestByDTag.set(dTag, candidate);
        }
      }

      const settingsDocs: PulledSettingsDoc[] = [];
      let settingsFound = 0;
      for (const name of canDecrypt ? SETTINGS_DOC_NAMES : []) {
        const event = newestByDTag.get(settingsDTag(name));
        if (!event) continue;
        settingsFound += 1;
        if (!nip01VersionIsNewer(event, storedVersions.get(name))) continue;

        // Deliberately not `decodeSettingsDoc`: it answers `null` both for a
        // signer that refused and for a document this build cannot parse, and
        // those must diverge. A refusal is the atomicity case — abort, having
        // applied nothing. A document another client wrote in a shape this one
        // doesn't understand is not a failure of the pull, and treating it as
        // one would leave the button permanently broken for that account.
        let plaintext: string;
        try {
          plaintext = await signer.nip44!.decrypt(user.pubkey, event.content);
        } catch {
          throw new Error(
            `Your private Armada settings (${name}) could not be decrypted; nothing was restored`,
          );
        }
        let value: unknown;
        try {
          value = JSON.parse(plaintext);
        } catch {
          continue; // Not JSON at all — same class as a schema miss.
        }
        const parsed = parseSettingsDoc(name, value);
        if (!parsed) continue;
        settingsDocs.push({ name, event, doc: parsed.doc as Record<string, unknown> });
      }

      let pulledCommunity: ListData | undefined;
      if (communitySet) {
        const cached = queryClient.getQueryData<ListData>(listQueryKey(user.pubkey));
        const persisted = await readFolded<PersistedList>(communityListFoldKey(user.pubkey));
        const local = cached?.list ?? persisted?.list;
        pulledCommunity = {
          event: communitySet.newestEvent,
          list: local
            ? mergeCommunityLists(local, communitySet.list)
            : communitySet.list,
          decryptFailed: false,
        };
      }

      let pulledInvites: InviteList | undefined;
      let pulledInviteCreatedAt = 0;
      if (inviteRead) {
        const cached = queryClient.getQueryData<InviteList>(inviteListKey(user.pubkey));
        pulledInvites = persistedInvites
          ? mergeInviteLists(inviteRead.list, persistedInvites.list)
          : inviteRead.list;
        if (cached) pulledInvites = mergeInviteLists(pulledInvites, cached);
        pulledInviteCreatedAt = Math.max(
          inviteRead.newestCreatedAt,
          persistedInvites?.newestCreatedAt ?? 0,
        );
      }

      const recordCount = Number(Boolean(discovery))
        + Number(Boolean(groupEvent))
        + Number(Boolean(searchEvent))
        + Number(Boolean(dmEvent))
        + Number(Boolean(blossomEvent))
        + communityEvents.length
        + Number(Boolean(inviteRead?.newestEvent))
        + topicHeads.length
        + settingsFound;
      if (recordCount === 0) {
        throw new Error("No portable setup was found on your account relays");
      }

      // Adopt the relay map FIRST. `adopt` schedules an invalidation of every
      // self-owned query key — including the four seeded below — for the next
      // macrotask, so seeding before it would hand the newly-adopted pool a
      // refetch that overwrites this pull's results. Yield past that
      // invalidation, then seed.
      if (discovery) {
        adopt(discovery);
        await nextMacrotask();
      }

      if (groupList?.event) {
        queryClient.setQueryData(["nip29", "user-groups", user.pubkey], {
          event: groupList.event,
          groups: groupList.groups,
          servers: groupList.servers,
          decryptFailed: false,
        });
        await writeFolded(groupListFoldKey(user.pubkey), {
          event: groupList.event,
          groups: groupList.groups,
          servers: groupList.servers,
        } satisfies PersistedGroupList).catch(() => undefined);
      }
      if (searchEvent && searchList) {
        queryClient.setQueryData<SearchRelayListQuery>(
          ["search-relay-list", user.pubkey],
          { event: searchEvent, ...searchList },
        );
      }
      if (dmEvent) {
        queryClient.setQueryData<DmRelayListQuery>(["dm-relay-list", user.pubkey], {
          event: dmEvent,
          relays: parseDmRelays(dmEvent),
        });
      }
      if (blossomEvent) {
        queryClient.setQueryData<BlossomServerListQuery>(
          ["blossom-server-list", user.pubkey],
          { event: blossomEvent, servers: parseBlossomServerList(blossomEvent) },
        );
      }

      // Persist every exact private wire record before exposing its decrypted
      // fold. This includes all Community List coordinates, the creator's
      // Invite List, and per-installation topic shards.
      for (const event of [...communityEvents, ...inviteEvents, ...topicEditions]) {
        await store.event(event).catch(() => undefined);
      }
      if (pulledCommunity) {
        await writeFolded(communityListFoldKey(user.pubkey), {
          event: pulledCommunity.event,
          list: pulledCommunity.list,
        } satisfies PersistedList).catch(() => undefined);
        queryClient.setQueryData(listQueryKey(user.pubkey), pulledCommunity);
      }
      if (pulledInvites) {
        await writeFolded(inviteListFoldKey(user.pubkey), {
          list: pulledInvites,
          newestCreatedAt: pulledInviteCreatedAt,
        } satisfies PersistedInviteList);
        queryClient.setQueryData(inviteListKey(user.pubkey), pulledInvites);
      }
      if (decodedDmIndex) {
        await hydrateDmConversationIndexShards(user.pubkey, decodedDmIndex.shards);
        queryClient.setQueryData(
          [...dmConversationIndexSyncQueryKey, user.pubkey, sources.slice().sort().join("\u0000")],
          decodedDmIndex,
        );
      }
      if (decodedFavoriteGifs) {
        hydrateFavoriteGifShards(user.pubkey, decodedFavoriteGifs.shards);
        queryClient.setQueryData([...favoriteGifsSyncQueryKey, user.pubkey], decodedFavoriteGifs);
      }

      // Durable first, then visible — the same order every other settings
      // writer uses. Without the store write a later refetch reads the disk
      // and puts the pre-pull version straight back in the cache.
      for (const { name, event, doc } of settingsDocs) {
        try {
          await store.event(event);
        } catch {
          // Superseded or unwritable; the cache seed below still applies it
          // for this session.
        }
        queryClient.setQueryData(settingsDocQueryKey(name, user.pubkey), { event, doc });
      }

      // Fold everything that mirrors AppConfig into one update. The list hooks
      // don't own their config mirrors (NostrSync does), and the settings
      // documents are applied by `useConfigDocSync` only while automatic sync
      // is on — which is precisely the case this action exists for.
      const metadata = settingsDocs.find((entry) => entry.name === "metadata");
      updateConfig((current) => {
        let next: AppConfig = current;
        if (searchList) next = { ...next, searchRelays: searchList.relays };
        if (dmEvent) next = { ...next, dmRelays: parseDmRelays(dmEvent) };
        if (blossomEvent && nip01VersionIsNewer(blossomEvent, {
          created_at: current.blossomServerMetadata.updatedAt,
          id: current.blossomServerMetadata.eventId ?? "\uffff",
        })) {
          next = {
            ...next,
            blossomServerMetadata: {
              servers: parseBlossomServerList(blossomEvent),
              updatedAt: blossomEvent.created_at,
              eventId: blossomEvent.id,
            },
          };
        }
        for (const { name, doc } of settingsDocs) {
          if (!(name in CONFIG_KEYS_BY_DOC)) continue;
          next = { ...next, ...docToConfigPatch(name as ConfigDocName, doc, next) };
        }
        // None of this is a user edit, so it must not be echoed back out as
        // one by the automatic publish watcher.
        markConfigSynced(next);
        return next;
      });

      return {
        records: recordCount,
        sources: sources.length,
        voiceServer: Boolean((metadata?.doc as MetadataDoc | undefined)?.preferredVoiceServer),
        publicOnly: !canDecrypt,
      };
    } finally {
      setIsPending(false);
    }
  }, [adopt, config, discover, eventStore, nostr, queryClient, updateConfig, user]);

  return { pull, isPending };
}

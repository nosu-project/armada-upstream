import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { selfStateRelays } from "@/contexts/AppContext";
import {
  communityListWireDiffers,
  fetchCommunityListFragments,
  signCommunityListSnapshot,
  syncCommunityList,
  type FragSet,
  type PersistedList,
} from "@/concord/hooks/useCommunityList";
import { communityListFoldKey, mergeCommunityLists } from "@/concord/lib/communityList";
import {
  decodeInviteListEvents,
  inviteListFoldKey,
  inviteListKey,
  readPersistedInviteList,
  type PersistedInviteList,
} from "@/concord/hooks/useInvites";
import { KIND_COMMUNITY_LIST_FRAG, KIND_INVITE_LIST } from "@/concord/lib/kinds";
import { mergeInviteLists, STOCK_RELAYS, type InviteList } from "@/concord/lib/invite";
import { useAppContext } from "@/hooks/useAppContext";
import {
  KIND_BLOSSOM_SERVERS,
  type BlossomServerListQuery,
} from "@/hooks/useBlossomServerList";
import {
  KIND_DM_RELAYS,
  parseDmRelays,
  type DmRelayListQuery,
} from "@/hooks/useDmRelayList";
import {
  decodeSettingsDoc,
  nextSettingsDoc,
  readSettingsDoc,
  settingsDocQueryKey,
  useSettingsDoc,
} from "@/hooks/useSettingsDoc";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { signCurrentDmConversationIndexEvents } from "@/hooks/useDmConversationIndexSync";
import { signCurrentFavoriteGifEvents } from "@/hooks/useFavoriteGifsSync";
import { parseBlossomServerList } from "@/lib/blossom";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { KIND_USER_GROUPS } from "@/lib/nip29";
import {
  KIND_RELAY_LIST,
  publishSignedEventToRelays,
  queryExplicitRelaysWithStatus,
  uniqueRelayUrls,
} from "@/lib/nip65";
import { APP_NAME, RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";
import {
  KIND_SEARCH_RELAYS,
  readSearchRelayList,
} from "@/lib/searchRelayList";
import type { SearchRelayListQuery } from "@/hooks/useSearchRelayList";
import {
  SETTINGS_DOC_NAMES,
  SETTINGS_DTAGS,
  SETTINGS_KIND,
  settingsDTag,
  type SettingsDocName,
} from "@/lib/settingsDocs";
import {
  CONFIG_KEYS_BY_DOC,
  configSnapshot,
  docToConfigPatch,
  type ConfigDocName,
} from "@/lib/syncedConfig";
import { SELF_SYNC_TOPIC_TAGS, T_ARMADA_DM_CONVERSATIONS } from "@/lib/selfSyncKinds";
import { isSigned } from "@/lib/nostrRumor";
import {
  queueSignedEvent,
  recordQueuedPublishAttempt,
  withSignature,
} from "@/lib/publishOutbox";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

const PUBLISH_TIMEOUT_MS = 8_000;
const MAX_PORTABLE_TOPIC_SHARDS = 512;

type PortableNostr = ReturnType<typeof useNostr>["nostr"];

export interface PortableWireState {
  events: NostrEvent[];
  communityEvents: NostrEvent[];
  communitySet: FragSet | null;
  /** Explicit relays that completed both the portable and fragment reads. */
  answered: string[];
}

function dTagOf(event: NostrRumor): string | undefined {
  return event.tags.find(([name]) => name === "d")?.[1];
}

export function newestPortableAddressableEvents<T extends NostrRumor>(
  events: Iterable<T>,
  kind: number,
): T[] {
  const byD = new Map<string, T>();
  for (const event of events) {
    if (event.kind !== kind) continue;
    const d = dTagOf(event);
    if (d === undefined) continue;
    const held = byD.get(d);
    if (!held || event.created_at > held.created_at
      || (event.created_at === held.created_at && event.id < held.id)) {
      byD.set(d, event);
    }
  }
  return [...byD.values()];
}

/** Read the bounded set of signed records that can be mirrored byte-for-byte. */
export async function fetchPortableWireState(
  nostr: PortableNostr,
  user: NonNullable<ReturnType<typeof useCurrentUser>["user"]>,
  sourceRelays: Iterable<string>,
  signal: AbortSignal,
  requiredSourceRelays: Iterable<string> = [],
  requireEverySource = true,
  localCommunityEvents: Iterable<NostrRumor> = [],
): Promise<PortableWireState> {
  const sources = uniqueRelayUrls(sourceRelays);
  const [response, inviteRescue] = await Promise.all([
    queryExplicitRelaysWithStatus(
      nostr,
      sources,
      [
        {
          kinds: [
            KIND_RELAY_LIST,
            KIND_SEARCH_RELAYS,
            KIND_USER_GROUPS,
            KIND_DM_RELAYS,
            KIND_BLOSSOM_SERVERS,
            KIND_INVITE_LIST,
          ],
          authors: [user.pubkey],
        },
        { kinds: [SETTINGS_KIND], authors: [user.pubkey], "#d": SETTINGS_DTAGS },
        {
          kinds: [SETTINGS_KIND],
          authors: [user.pubkey],
          "#t": SELF_SYNC_TOPIC_TAGS,
          limit: MAX_PORTABLE_TOPIC_SHARDS,
        },
        {
          kinds: [KIND_COMMUNITY_LIST_FRAG],
          authors: [user.pubkey],
          limit: 4096,
        },
      ],
      signal,
    ),
    // Creator Invite Lists are deliberately also written to the CORD stock
    // rescue set. Query kind 13303 there independently so a revocation held
    // only by a stock relay joins the CRDT merge, without widening any other
    // private settings document to public rescue relays.
    queryExplicitRelaysWithStatus(
      nostr,
      STOCK_RELAYS,
      [{ kinds: [KIND_INVITE_LIST], authors: [user.pubkey] }],
      signal,
    ),
  ]);
  const required = new Set(uniqueRelayUrls(requiredSourceRelays));
  const events = [...new Map(
    [...response.events, ...inviteRescue.events].map((event) => [event.id, event]),
  ).values()];
  const fragments = await fetchCommunityListFragments(
    nostr,
    user,
    sources,
    signal,
    localCommunityEvents,
    events,
  );
  const answered = response.answered.filter((url) => fragments.answered.includes(url));
  const completeSources = [...required].filter((url) =>
    response.answered.includes(url) && fragments.answered.includes(url));
  const sourceRequirementFailed = required.size > 0 && (
    requireEverySource
      ? completeSources.length !== required.size
      : completeSources.length === 0
  );
  if (sourceRequirementFailed) {
    throw new Error(requireEverySource
      ? "Not all current account-state relays completed the portable-state read; the NIP-65 relay set was not changed"
      : "No bootstrap account-state relay completed the portable-state read; the NIP-65 relay set was not changed");
  }
  if (fragments.unreadable) {
    throw new Error("Your encrypted community list could not be decrypted; nothing was published");
  }
  if (fragments.set && !fragments.set.complete) {
    throw new Error(
      `Only ${fragments.set.createdAt.size} of ${fragments.set.declared} community-list fragments were found; nothing was published`,
    );
  }
  const communityEvents = fragments.set
    ? [...fragments.set.winningEvents.values()].filter(isSigned)
    : [];
  return { events, communityEvents, communitySet: fragments.set, answered };
}

const PORTABLE_CONFIRM_FILTER_CHUNK = 32;

function portableCoordinate(event: NostrEvent): string {
  if (event.kind >= 30_000 && event.kind < 40_000) {
    const d = dTagOf(event);
    if (d === undefined) {
      throw new Error(`Portable addressable record kind ${event.kind} has no d tag`);
    }
    return `${event.kind}:${event.pubkey}:${d}`;
  }
  if (event.kind === 0 || event.kind === 3
    || (event.kind >= 10_000 && event.kind < 20_000)) {
    return `${event.kind}:${event.pubkey}`;
  }
  throw new Error(`Portable record kind ${event.kind} is not replaceable`);
}

function portableCoordinateFilter(event: NostrEvent): NostrFilter {
  const filter: NostrFilter = {
    kinds: [event.kind],
    authors: [event.pubkey],
    limit: 8,
  };
  if (event.kind >= 30_000 && event.kind < 40_000) {
    filter["#d"] = [dTagOf(event)!];
  }
  return filter;
}

function newerPortableRecord(candidate: NostrEvent, current: NostrEvent | undefined): boolean {
  return !current
    || candidate.created_at > current.created_at
    || (candidate.created_at === current.created_at && candidate.id < current.id);
}

/**
 * EVENT OK proves receipt, not which replaceable event a relay retained. Read
 * each destination back and require the exact expected NIP-01 head before a
 * NIP-65 pointer is allowed to make that relay authoritative.
 */
export async function confirmPortableRecordHeads(
  nostr: PortableNostr,
  events: Iterable<NostrEvent>,
  targetRelays: Iterable<string>,
): Promise<void> {
  const targets = uniqueRelayUrls(targetRelays);
  const expectedByCoordinate = new Map<string, NostrEvent>();
  for (const event of events) {
    const coordinate = portableCoordinate(event);
    const held = expectedByCoordinate.get(coordinate);
    if (newerPortableRecord(event, held)) expectedByCoordinate.set(coordinate, event);
  }
  const expected = [...expectedByCoordinate.values()];

  for (const target of targets) {
    for (let offset = 0; offset < expected.length; offset += PORTABLE_CONFIRM_FILTER_CHUNK) {
      const chunk = expected.slice(offset, offset + PORTABLE_CONFIRM_FILTER_CHUNK);
      const read = await queryExplicitRelaysWithStatus(
        nostr,
        [target],
        chunk.map(portableCoordinateFilter),
        AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      );
      if (!read.answered.includes(target)) {
        throw new Error(
          `The new account-state relay ${target} could not be read back; the NIP-65 relay set was not changed`,
        );
      }
      for (const wanted of chunk) {
        const coordinate = portableCoordinate(wanted);
        let retained: NostrEvent | undefined;
        for (const candidate of read.events) {
          if (portableCoordinate(candidate) !== coordinate) continue;
          if (newerPortableRecord(candidate, retained)) retained = candidate;
        }
        if (retained?.id !== wanted.id) {
          throw new Error(
            `The new account-state relay ${target} did not retain setup record kind ${wanted.kind} as its NIP-01 winner; the relay set was not changed`,
          );
        }
      }
    }
  }
}

/** Durable exact-byte fan-out shared by Setup Sync and two-phase NIP-65 edits. */
export async function publishSignedPortableRecords(
  nostr: PortableNostr,
  events: Iterable<NostrEvent>,
  targetRelays: Iterable<string>,
  requireEveryDestination = false,
): Promise<{ records: number; rejectedDeliveries: number }> {
  const targets = uniqueRelayUrls(targetRelays);
  if (targets.length === 0) throw new Error("No portable-state destination is available");
  const uniqueEvents = [...new Map([...events].map((event) => [event.id, event])).values()];
  let rejectedDeliveries = 0;
  for (const event of uniqueEvents) {
    // Do not begin a fan-out without a durable exact-byte retry entry. If the
    // queue store is unavailable, a partial success cannot safely be called
    // portable.
    await queueSignedEvent(event, undefined, targets, { inheritPendingTargets: false });
    const result = await publishSignedEventToRelays(nostr, event, targets, PUBLISH_TIMEOUT_MS);
    await recordQueuedPublishAttempt(event.id, targets, result.rejected).catch(() => undefined);
    rejectedDeliveries += result.rejected.length;
    if (result.accepted.length === 0) {
      throw new Error(`No relay accepted setup record kind ${event.kind}`);
    }
    if (requireEveryDestination && result.rejected.length > 0) {
      throw new Error(
        `The new relay set is still missing setup record kind ${event.kind}; retry before changing NIP-65 relays`,
      );
    }
  }
  if (requireEveryDestination) {
    await confirmPortableRecordHeads(nostr, uniqueEvents, targets);
  }
  return { records: uniqueEvents.length, rejectedDeliveries };
}

/**
 * Phase one of a NIP-65 relay edit: copy all exact portable state to the
 * proposed write set. A divergent creator-invite list requires explicit Setup
 * Sync first, because exact mirroring cannot safely choose one lossy copy.
 */
export interface PortableMirrorResult {
  records: number;
  /** Stable iff every expected replaceable/addressable head is unchanged. */
  fingerprint: string;
}

export async function mirrorPortableStateBeforeRelayChange(
  nostr: PortableNostr,
  user: NonNullable<ReturnType<typeof useCurrentUser>["user"]>,
  sourceRelays: Iterable<string>,
  proposedWriteRelays: Iterable<string>,
  requiredSourceRelays: Iterable<string> = sourceRelays,
  requireEverySource = true,
  localSingletons: NostrRumor[] = [],
): Promise<PortableMirrorResult> {
  const proposed = uniqueRelayUrls(proposedWriteRelays);
  const readRelays = uniqueRelayUrls([...sourceRelays, ...proposed]);
  const wire = await fetchPortableWireState(
    nostr,
    user,
    readRelays,
    AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    requiredSourceRelays,
    requireEverySource,
    localSingletons.filter((event) => event.kind === KIND_COMMUNITY_LIST_FRAG),
  );
  if (!proposed.every((url) => wire.answered.includes(url))) {
    throw new Error(
      "Every proposed account-state relay must complete a portable-state read before the NIP-65 relay set can be changed",
    );
  }
  const persistedCommunity = await readFolded<PersistedList>(
    communityListFoldKey(user.pubkey),
  );
  const knownCommunityList = persistedCommunity && wire.communitySet
    ? mergeCommunityLists(wire.communitySet.list, persistedCommunity.list)
    : (persistedCommunity?.list ?? wire.communitySet?.list);
  const hasKnownCommunityFacts = Boolean(
    knownCommunityList
    && (knownCommunityList.entries.length > 0 || knownCommunityList.tombstones.length > 0),
  );
  if (hasKnownCommunityFacts && !wire.communitySet) {
    throw new Error(
      "A known community list was absent from the current relay read; the NIP-65 relay set was not changed",
    );
  }
  const communityNeedsConsolidation = Boolean(
    wire.communitySet
    && (
      wire.communityEvents.length !== wire.communitySet.winningEvents.size
      || communityListWireDiffers(knownCommunityList ?? wire.communitySet.list, wire.communitySet)
    ),
  );
  const communityRecords = communityNeedsConsolidation
    ? await signCommunityListSnapshot(
      user,
      knownCommunityList ?? wire.communitySet!.list,
      wire.communitySet,
    )
    : wire.communityEvents;
  const records: NostrEvent[] = [];
  for (const kind of [KIND_SEARCH_RELAYS, KIND_USER_GROUPS, KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS]) {
    const winner = newestPortableSingleton([...wire.events, ...localSingletons], kind);
    const event = winner
      ? await signedPortableRumor(user, winner)
      : undefined;
    if (event) records.push(event);
  }
  const fixedAddressableEditions = [...wire.events, ...localSingletons].filter((event) =>
    event.kind === SETTINGS_KIND
    && SETTINGS_DTAGS.includes(dTagOf(event) ?? ""));
  const addressableHeads = await Promise.all(
    newestPortableAddressableEvents(fixedAddressableEditions, SETTINGS_KIND)
      .map((event) => signedPortableRumor(user, event)),
  );
  const topicEditions = [...wire.events, ...localSingletons].filter((event) =>
    event.kind === SETTINGS_KIND
    && event.tags.some(
      ([name, value]) => name === "t" && SELF_SYNC_TOPIC_TAGS.includes(value),
    ));
  const repairedTopics = [
    ...await signCurrentDmConversationIndexEvents(
      topicEditions.filter((event) => event.tags.some(
        ([name, value]) => name === "t" && value === T_ARMADA_DM_CONVERSATIONS,
      )),
      user.signer,
      user.pubkey,
    ),
    ...await signCurrentFavoriteGifEvents(
      topicEditions.filter((event) => event.tags.some(
        ([name, value]) => name === "t" && value !== T_ARMADA_DM_CONVERSATIONS,
      )),
      user.signer,
      user.pubkey,
    ),
  ];
  const repairedTopicCoordinates = new Set(repairedTopics.map((event) => dTagOf(event)));
  const untouchedTopicHeads = await Promise.all(
    newestPortableAddressableEvents(topicEditions, SETTINGS_KIND)
      .filter((event) => !repairedTopicCoordinates.has(dTagOf(event)))
      .map((event) => signedPortableRumor(user, event)),
  );
  records.push(
    ...addressableHeads,
    ...untouchedTopicHeads,
    ...repairedTopics,
  );
  records.push(...communityRecords);

  const inviteEvents = [...wire.events, ...localSingletons]
    .filter((event) => event.kind === KIND_INVITE_LIST);
  const persistedInvites = await readPersistedInviteList(user.pubkey);
  // Same rule as the community list above: a list this device knows was
  // published (a folded relay version, or a local copy of the event) that the
  // read did not return means the read was incomplete, and a fresh edition
  // built without it would replace the relay copy with whatever the fold lacks.
  const knownPublishedInvites = Boolean(
    (persistedInvites && persistedInvites.newestCreatedAt > 0)
    || localSingletons.some((event) => event.kind === KIND_INVITE_LIST),
  );
  if (knownPublishedInvites && !wire.events.some((event) => event.kind === KIND_INVITE_LIST)) {
    throw new Error(
      "A known creator invite list was absent from the current relay read; the NIP-65 relay set was not changed",
    );
  }
  if (inviteEvents.length > 0 || persistedInvites) {
    const invite = await decodeInviteListEvents(inviteEvents, user);
    const complete = persistedInvites
      ? mergeInviteLists(invite.list, persistedInvites.list)
      : invite.list;
    if (invite.unreadable) {
      throw new Error(
        "Your creator invite records could not be decrypted; the NIP-65 relay set was not changed",
      );
    }
    const foldIsAhead = Boolean(
      persistedInvites
      && persistedInvites.newestCreatedAt > invite.newestCreatedAt,
    );
    if (invite.exactEvent
      && !foldIsAhead
      && JSON.stringify(complete) === JSON.stringify(invite.list)) {
      records.push(invite.exactEvent);
    } else {
      if (!user.signer.nip44) throw new Error("Your signer cannot encrypt creator invite records");
      const event = await user.signer.signEvent({
        kind: KIND_INVITE_LIST,
        content: await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(complete)),
        tags: [],
        created_at: Math.max(
          Math.floor(Date.now() / 1000),
          invite.newestCreatedAt + 1,
          (persistedInvites?.newestCreatedAt ?? 0) + 1,
        ),
      });
      if (event.pubkey !== user.pubkey) throw new Error("The signer returned a different account");
      records.push(event);
    }
  }
  const result = await publishSignedPortableRecords(
    nostr,
    records,
    proposed,
    true,
  );
  const fingerprint = [...new Map(records.map((event) => [portableCoordinate(event), event])).values()]
    .map((event) => `${portableCoordinate(event)}:${event.id}`)
    .sort()
    .join("|");
  return { records: result.records, fingerprint };
}

export interface PortableSetupPublishResult {
  records: number;
  destinations: number;
  rejectedDeliveries: number;
  /**
   * Settings documents that exist on this device but that no relay returned,
   * and so were left alone. Rebuilding one from a base we couldn't confirm
   * would silently drop whatever the local copy is missing.
   */
  unrefreshed: SettingsDocName[];
}

function newestPortableSingleton(
  events: Iterable<NostrEvent | NostrRumor>,
  kind: number,
): NostrEvent | NostrRumor | undefined {
  return [...events]
    .filter((event) => event.kind === kind)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

/** Resolve wire + ArmadaDB, recovering exact bytes from the outbox if needed. */
export async function signedPortableSingletonWinner(
  wireEvents: NostrEvent[],
  localEvents: NostrRumor[],
  kind: number,
): Promise<NostrEvent | undefined> {
  const winner = newestPortableSingleton([...wireEvents, ...localEvents], kind);
  if (!winner) return undefined;
  const signedWire = wireEvents.find((event) => event.id === winner.id && isSigned(event));
  if (signedWire) return signedWire;
  try {
    return await withSignature(winner);
  } catch {
    throw new Error(
      `A newer local setup record (kind ${kind}) has no retained signature; refusing to mirror an older relay copy`,
    );
  }
}

/**
 * Recover a local rumor's exact bytes when they remain queued; otherwise sign
 * the same authenticated content/tags at a newer version. ArmadaDB
 * deliberately strips signatures, so refusing every such winner would make a
 * successfully delivered Android-background update impossible to migrate.
 */
async function signedPortableRumor(
  user: NonNullable<ReturnType<typeof useCurrentUser>["user"]>,
  rumor: NostrRumor,
): Promise<NostrEvent> {
  try {
    return await withSignature(rumor);
  } catch {
    const event = await user.signer.signEvent({
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      created_at: nextCreatedAt(rumor),
    });
    if (event.pubkey !== user.pubkey) throw new Error("The signer returned a different account");
    return event;
  }
}

function nextCreatedAt(prev: NostrRumor | undefined): number {
  const now = Math.floor(Date.now() / 1000);
  return prev ? Math.max(now, prev.created_at + 1) : now;
}

/**
 * Build the local patch for explicit Setup Sync. The additive DM fields must
 * union with the decrypted relay base before it is re-signed; otherwise a
 * device with a stale local snapshot can erase pins, hides, accepts, or
 * message-less threads that another device added.
 */
export function portableConfigSnapshot(
  name: ConfigDocName,
  base: Record<string, unknown>,
  config: Parameters<typeof configSnapshot>[0],
): Record<string, unknown> {
  const local = configSnapshot(config, name);
  if (name !== "dms") return local;
  const mergedRemote = docToConfigPatch("dms", base, config);
  return {
    ...local,
    ...mergedRemote,
    // Mutable preference, not an additive set: this explicit Sync publishes
    // the value currently selected on this device.
    ...(local.dmProtocol !== undefined ? { dmProtocol: local.dmProtocol } : {}),
  };
}

/**
 * Explicitly make the current account setup recoverable from every NIP-65
 * write relay. Existing signed list events are mirrored byte-for-byte; a
 * missing canonical service list is created only when the user has a non-empty
 * value in Settings. Armada's private preferences are merged into the latest
 * decryptable NIP-78 document, never built over an ambiguous failed read.
 */
export function usePublishPortableSetup() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const [isPending, setIsPending] = useState(false);
  const metadataDoc = useSettingsDoc("metadata");
  const ownsRelayList = !!user && config.relayMetadata.pubkey === user.pubkey;
  const hasSyncRelay = ownsRelayList
    && config.relayMetadata.relays.some((relay) => relay.write);
  const isConfigured = Boolean(user?.signer.nip44 && metadataDoc.doc && hasSyncRelay);
  const isAutomatic = isConfigured && config.automaticSettingsSync !== false;

  const publish = useCallback(async (): Promise<PortableSetupPublishResult> => {
    if (!user) throw new Error("Not logged in");
    if (!user.signer.nip44) throw new Error("Your signer does not support encrypted settings");

    const ownsRelayList = config.relayMetadata.pubkey === user.pubkey;
    const targets = uniqueRelayUrls(
      ownsRelayList
        ? config.relayMetadata.relays
            .filter((relay) => relay.write)
            .map((relay) => relay.url)
        : [],
    );
    if (targets.length === 0) {
      throw new Error("Publish a NIP-65 write relay first");
    }

    setIsPending(true);
    try {
      const sources = uniqueRelayUrls([
        ...selfStateRelays(config, user.pubkey),
        ...targets,
        ...RELAY_LIST_DISCOVERY_RELAYS,
      ]);
      const store = await eventStore;
      let localPortableRumors: NostrRumor[] = [];
      try {
        localPortableRumors = await store.query([{
          kinds: [
            KIND_RELAY_LIST,
            KIND_SEARCH_RELAYS,
            KIND_USER_GROUPS,
            KIND_DM_RELAYS,
            KIND_BLOSSOM_SERVERS,
            KIND_INVITE_LIST,
            SETTINGS_KIND,
            KIND_COMMUNITY_LIST_FRAG,
          ],
          authors: [user.pubkey],
        }]);
      } catch {
        // Wire + folded plaintext remain available when ArmadaDB is not.
      }
      // Consolidate this device's folded Concord facts onto the current wire
      // before taking the exact events that Setup Sync mirrors. Without this,
      // an offline-era join held only in the local fold would be omitted from
      // the very action the user expects to make it portable.
      const community = await syncCommunityList(
        nostr,
        user,
        queryClient,
        undefined,
        uniqueRelayUrls([...selfStateRelays(config, user.pubkey), ...targets]),
        localPortableRumors.filter((event) => event.kind === KIND_COMMUNITY_LIST_FRAG),
      );
      const wire = await fetchPortableWireState(
        nostr,
        user,
        sources,
        AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      );
      const localSingletons = localPortableRumors.filter(
        (event) => event.kind !== KIND_COMMUNITY_LIST_FRAG,
      );
      const hasCommunityFacts = community.list.entries.length > 0
        || community.list.tombstones.length > 0;
      if (hasCommunityFacts && (
        !wire.communitySet
        || communityListWireDiffers(community.list, wire.communitySet)
      )) {
        throw new Error("Your complete community list did not reach the account relays; nothing was published");
      }
      const { events } = wire;

      const relayList = await signedPortableSingletonWinner(
        events,
        localSingletons,
        KIND_RELAY_LIST,
      );
      if (!relayList) {
        throw new Error("Could not refresh your signed NIP-65 list; nothing was published");
      }

      // Portable data goes first and the discovery pointer LAST. This is
      // immaterial for an unchanged NIP-65 set, and prevents a partial run
      // from advertising destinations before they hold the state they name.
      const toPublish: NostrEvent[] = [...wire.communityEvents];
      const groupWinner = newestPortableSingleton(
        [...events, ...localSingletons],
        KIND_USER_GROUPS,
      );
      const groupList = groupWinner
        ? await signedPortableRumor(user, groupWinner)
        : undefined;
      if (groupList) toPublish.push(groupList);

      let searchEvent = await signedPortableSingletonWinner(
        events,
        localSingletons,
        KIND_SEARCH_RELAYS,
      );
      if (!searchEvent && config.searchRelays.length > 0) {
        searchEvent = await user.signer.signEvent({
          kind: KIND_SEARCH_RELAYS,
          content: "",
          tags: config.searchRelays.map((relay) => ["relay", relay]),
          created_at: nextCreatedAt(undefined),
        });
      }
      if (searchEvent) toPublish.push(searchEvent);

      let dmEvent = await signedPortableSingletonWinner(
        events,
        localSingletons,
        KIND_DM_RELAYS,
      );
      if (!dmEvent && config.dmRelays.length > 0) {
        dmEvent = await user.signer.signEvent({
          kind: KIND_DM_RELAYS,
          content: "",
          tags: config.dmRelays.map((relay) => ["relay", relay]),
          created_at: nextCreatedAt(undefined),
        });
      }
      if (dmEvent) toPublish.push(dmEvent);

      let blossomEvent = await signedPortableSingletonWinner(
        events,
        localSingletons,
        KIND_BLOSSOM_SERVERS,
      );
      if (!blossomEvent && config.blossomServerMetadata.servers.length > 0) {
        blossomEvent = await user.signer.signEvent({
          kind: KIND_BLOSSOM_SERVERS,
          content: "",
          tags: config.blossomServerMetadata.servers.map((server) => ["server", server]),
          created_at: nextCreatedAt(undefined),
        });
      }
      if (blossomEvent) toPublish.push(blossomEvent);

      // Dynamic, per-installation NIP-78 shards (GIF favorites today, DM
      // conversation indices as they appear) are exact signed mirrors. Their
      // bounded public `t` tag is the catalogue; `d` remains the coordinate.
      const topicEditions = [...events, ...localSingletons].filter((event) =>
        event.kind === SETTINGS_KIND
        && event.tags.some(
          ([name, value]) => name === "t" && SELF_SYNC_TOPIC_TAGS.includes(value),
        ));
      const topicHeads = newestPortableAddressableEvents(topicEditions, SETTINGS_KIND);
      const remoteDmIndexEvents = topicEditions.filter((event) => event.tags.some(
        ([name, value]) => name === "t" && value === T_ARMADA_DM_CONVERSATIONS,
      ));
      const signedDmIndexEvents = await signCurrentDmConversationIndexEvents(
        remoteDmIndexEvents,
        user.signer,
        user.pubkey,
      );
      const remoteFavoriteGifEvents = topicEditions.filter((event) => event.tags.some(
        ([name, value]) => name === "t" && value !== T_ARMADA_DM_CONVERSATIONS,
      ));
      const signedFavoriteGifEvents = await signCurrentFavoriteGifEvents(
        remoteFavoriteGifEvents,
        user.signer,
        user.pubkey,
      );
      const replacedTopicCoordinates = new Set([
        ...signedDmIndexEvents,
        ...signedFavoriteGifEvents,
      ].map((event) => dTagOf(event)));
      const untouchedTopicEvents = await Promise.all(
        topicHeads
          .filter((event) => !replacedTopicCoordinates.has(dTagOf(event)))
          .map((event) => signedPortableRumor(user, event)),
      );
      const portableTopicEvents = [
        ...untouchedTopicEvents,
        ...signedDmIndexEvents,
        ...signedFavoriteGifEvents,
      ];
      toPublish.push(...portableTopicEvents);

      // Creator invite bookkeeping contains revocation secrets and terminal
      // tombstones. If stale relays expose divergent copies, consolidate their
      // semantic union into one fresh event instead of mirroring whichever
      // lossy replaceable happened to be newest.
      const inviteEvents = [...events, ...localSingletons]
        .filter((event) => event.kind === KIND_INVITE_LIST);
      const decodedInvites = await decodeInviteListEvents(inviteEvents, user);
      if (decodedInvites.unreadable) {
        throw new Error("Your creator invite records could not be decrypted; nothing was published");
      }
      const cachedInvites = queryClient.getQueryData<InviteList>(inviteListKey(user.pubkey));
      const persistedInvites = await readPersistedInviteList(user.pubkey);
      let inviteList = decodedInvites.list;
      if (persistedInvites) inviteList = mergeInviteLists(inviteList, persistedInvites.list);
      if (cachedInvites) inviteList = mergeInviteLists(inviteList, cachedInvites);
      let inviteSeed: {
        event: NostrEvent;
        list: InviteList;
        newestCreatedAt: number;
      } | undefined;
      if (decodedInvites.exactEvent
        && JSON.stringify(inviteList) === JSON.stringify(decodedInvites.list)
        && (persistedInvites?.newestCreatedAt ?? 0) <= decodedInvites.newestCreatedAt) {
        toPublish.push(decodedInvites.exactEvent);
        inviteSeed = {
          event: decodedInvites.exactEvent,
          list: inviteList,
          newestCreatedAt: decodedInvites.newestCreatedAt,
        };
      } else if (inviteEvents.length > 0
        || inviteList.entries.length > 0
        || inviteList.tombstones.length > 0) {
        const newestCreatedAt = Math.max(
          decodedInvites.newestCreatedAt,
          persistedInvites?.newestCreatedAt ?? 0,
        );
        const event = await user.signer.signEvent({
          kind: KIND_INVITE_LIST,
          content: await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(inviteList)),
          tags: [],
          created_at: Math.max(
            nextCreatedAt(decodedInvites.newestEvent ?? undefined),
            newestCreatedAt + 1,
          ),
        });
        toPublish.push(event);
        inviteSeed = { event, list: inviteList, newestCreatedAt: event.created_at };
      }

      // Each of the six settings documents, handled independently. A document
      // this account has never written simply isn't there, which is not a
      // failure — but one that exists locally and came back from NO relay is,
      // and is skipped rather than rebuilt from a base we can't confirm.
      const settingsSeeds: { name: SettingsDocName; event: NostrEvent; doc: unknown }[] = [];
      const unrefreshed: SettingsDocName[] = [];

      for (const name of SETTINGS_DOC_NAMES) {
        // The relays' newest copy and ArmadaDB's compete. The store is where
        // the standing self-state REQ files every version as it arrives — and
        // on Android, where the notification service files them while the app
        // is dead — so it can hold one the relays we just asked have not
        // caught up to. Merging over the older of the two would republish it
        // as newest.
        const stored = await readSettingsDoc(store, user.signer, user.pubkey, name);
        const dTag = settingsDTag(name);
        const fromRelays = events
          .filter((event) =>
            event.kind === SETTINGS_KIND
            && event.tags.some(([tag, value]) => tag === "d" && value === dTag))
          .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];

        // We know the user has this document, and this read didn't find it:
        // every relay we asked failed or is behind. Publishing a base we can't
        // confirm would drop whatever it is missing, on every device. Skipping
        // one document doesn't compromise the others — they're separate
        // coordinates — so the rest of the setup still gets published.
        if (!fromRelays && stored) {
          unrefreshed.push(name);
          continue;
        }

        const configKeys = name in CONFIG_KEYS_BY_DOC ? (name as ConfigDocName) : undefined;
        // Read-state and reactions are owned by their modules rather than
        // AppConfig. Still arbitrate ArmadaDB against the wire by full NIP-01
        // ordering: Android can file a newer signed document while JS is dead,
        // and mirroring an older relay copy would regress a monotonic map. Use
        // its exact retained signature when possible; otherwise surface this
        // coordinate as unrefreshed instead of claiming synchronization.
        if (!configKeys) {
          try {
            const winner = await signedPortableSingletonWinner(
              fromRelays ? [fromRelays] : [],
              stored ? [stored.event] : [],
              SETTINGS_KIND,
            );
            if (winner) toPublish.push(winner);
          } catch {
            unrefreshed.push(name);
          }
          continue;
        }

        let previous: NostrRumor | undefined = fromRelays;
        let base: Record<string, unknown> = {};
        const storedWins = stored && (
          !fromRelays
          || stored.event.created_at > fromRelays.created_at
          || (
            stored.event.created_at === fromRelays.created_at
            && stored.event.id < fromRelays.id
          )
        );
        if (stored && storedWins) {
          previous = stored.event;
          base = stored.doc as Record<string, unknown>;
        } else if (fromRelays) {
          const decoded = await decodeSettingsDoc(fromRelays, user.signer, user.pubkey, name);
          if (!decoded) {
            throw new Error(
              `Could not decrypt your existing private settings (${name}); nothing was published`,
            );
          }
          base = decoded.doc as Record<string, unknown>;
        }

        const next = nextSettingsDoc(
          name,
          base as never,
          portableConfigSnapshot(configKeys, base, config) as never,
        );
        const settingsEvent = await user.signer.signEvent({
          kind: SETTINGS_KIND,
          content: await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(next)),
          tags: previous
            ? previous.tags.filter(([tag]) => tag !== "client")
            : [["d", dTag], ["title", `${APP_NAME} Settings`]],
          created_at: nextCreatedAt(previous),
        });
        toPublish.push(settingsEvent);
        settingsSeeds.push({ name, event: settingsEvent, doc: next });
      }

      toPublish.push(relayList);
      const uniqueToPublish = [...new Map(toPublish.map((event) => [event.id, event])).values()];
      for (const event of uniqueToPublish) {
        if (event.pubkey !== user.pubkey) throw new Error("The signer returned a different account");
      }

      const portableResult = await publishSignedPortableRecords(
        nostr,
        uniqueToPublish.filter((event) => event.kind !== KIND_RELAY_LIST),
        targets,
      );
      const pointerResult = await publishSignedPortableRecords(
        nostr,
        [relayList],
        uniqueRelayUrls([...targets, ...RELAY_LIST_DISCOVERY_RELAYS]),
      );
      const rejectedDeliveries = portableResult.rejectedDeliveries + pointerResult.rejectedDeliveries;

      if (searchEvent) {
        queryClient.setQueryData<SearchRelayListQuery>(
          ["search-relay-list", user.pubkey],
          { event: searchEvent, ...(await readSearchRelayList(searchEvent, user.signer)) },
        );
      }
      if (dmEvent) {
        queryClient.setQueryData<DmRelayListQuery>(["dm-relay-list", user.pubkey], {
          event: dmEvent,
          relays: parseDmRelays(dmEvent),
        });
      }
      if (blossomEvent) {
        const servers = parseBlossomServerList(blossomEvent);
        queryClient.setQueryData<BlossomServerListQuery>(
          ["blossom-server-list", user.pubkey],
          { event: blossomEvent, servers },
        );
        updateConfig((current) => ({
          ...current,
          blossomServerMetadata: {
            servers,
            updatedAt: blossomEvent!.created_at,
            eventId: blossomEvent!.id,
          },
        }));
      }
      // Into the store like every other version of these documents, so the
      // next read — here or in the notification service — sees what we
      // published.
      for (const { name, event, doc } of settingsSeeds) {
        await store.event(event);
        queryClient.setQueryData(settingsDocQueryKey(name, user.pubkey), { event, doc });
      }
      for (const event of [...wire.communityEvents, ...portableTopicEvents, ...(inviteSeed ? [inviteSeed.event] : [])]) {
        await store.event(event).catch(() => undefined);
      }
      if (inviteSeed) {
        await writeFolded(inviteListFoldKey(user.pubkey), {
          list: inviteSeed.list,
          newestCreatedAt: inviteSeed.newestCreatedAt,
        } satisfies PersistedInviteList);
        queryClient.setQueryData(inviteListKey(user.pubkey), inviteSeed.list);
      }
      if (wire.communityEvents.length > 0) {
        await queryClient.invalidateQueries({ queryKey: ["concord", "list", user.pubkey] });
      }
      for (const topic of SELF_SYNC_TOPIC_TAGS) {
        if (!portableTopicEvents.some((event) => event.tags.some(([name, value]) => name === "t" && value === topic))) continue;
        queryClient.invalidateQueries({
          queryKey: topic === T_ARMADA_DM_CONVERSATIONS
            ? ["dm-conversations-sync"]
            : ["favorite-gifs-sync"],
        });
      }

      return {
        records: uniqueToPublish.length,
        destinations: targets.length,
        rejectedDeliveries,
        unrefreshed,
      };
    } finally {
      setIsPending(false);
    }
  }, [config, eventStore, nostr, queryClient, updateConfig, user]);

  return {
    publish,
    isPending,
    isConfigured,
    isAutomatic,
    isStatusLoading: metadataDoc.isLoading,
  };
}

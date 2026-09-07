import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { verifyEventOnce } from "@/lib/verifyCache";

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";

import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import {
  dmConversationDeviceId,
  hydrateDmConversationIndexShards,
  loadOwnDmConversationIndexShards,
  ownDmConversationIndexNeedsPublish,
  recordDmConversationIndex,
  subscribeDmConversationIndexChanges,
} from "@/hooks/useDmConversationIndex";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDMConversations } from "@/hooks/useDirectMessages";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useEventStore } from "@/hooks/useEventStore";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import {
  DM_CONVERSATIONS_EVENT_KIND,
  DM_CONVERSATIONS_EVENT_TAG,
  DM_CONVERSATIONS_SYNC_QUERY_KEY,
  dmConversationIndexEventGroups,
  dmConversationIndexDTag,
  dmConversationIndexFilter,
  fitDmConversationIndexShard,
  mergeDmConversationIndexRecords,
  parseDmConversationIndexPlaintext,
  parseDmConversationIndexDTag,
  serializeDmConversationIndexShard,
  type DmConversationIndexShard,
} from "@/lib/dmConversationIndex";
import { isSigned, type NostrRumor } from "@/lib/nostrRumor";
import { APP_NAME, normalizeRelayUrl } from "@/lib/platform";
import { isPublishQueuedError } from "@/lib/publishOutbox";

/** A conversation burst should produce one signer interaction, not one per message. */
export const DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS = 60_000;
/** Recheck an unavailable merge base without polling once sync is healthy. */
export const DM_CONVERSATION_INDEX_PULL_RETRY_MS = 60_000;
export const DM_CONVERSATION_INDEX_RETRY_MS = 5 * 60_000;

export interface DecodedDmConversationIndex {
  shards: DmConversationIndexShard[];
  heads: Map<string, { event: NostrRumor; shard: DmConversationIndexShard }>;
  unreadable: Set<string>;
}

interface DmConversationIndexPull extends DecodedDmConversationIndex {
  /** Binds this result to the exact account + relay set it was read from. */
  baseKey: string;
  /** Only relays whose current edition participated in this merge base. */
  publishRelays: string[];
  /** Decrypt-validated relay-local heads; aggregate winners cannot hide a stale relay. */
  relayReads: Map<string, Pick<DecodedDmConversationIndex, "heads" | "unreadable">>;
  /** Exact own-shard coordinates each answered relay still needs. */
  repairTargets: Map<number, string[]>;
  /** Exact non-current-installation coordinate repairs, keyed by full d-tag. */
  departedRepairs: Map<string, DmConversationIndexCoordinateRepair>;
  /** A failed, unreadable, stale or missing relay-local read still needs confirmation. */
  repairPending: boolean;
}

type DmConversationIndexRelayTargets = ReadonlyMap<number, readonly string[]>;

interface DmConversationIndexCoordinateRepair {
  shard: DmConversationIndexShard;
  previous?: NostrRumor;
  relays: string[];
}

function dmConversationIndexDepartedRepairPlan(
  decoded: DecodedDmConversationIndex,
  ownDeviceId: string,
  answeredRelays: readonly string[],
  relayReads: ReadonlyMap<
    string,
    Pick<DecodedDmConversationIndex, "heads" | "unreadable">
  >,
): Map<string, DmConversationIndexCoordinateRepair> {
  const repairs = new Map<string, DmConversationIndexCoordinateRepair>();
  for (const shard of decoded.shards) {
    if (shard.deviceId === ownDeviceId) continue;
    const identifier = dmConversationIndexDTag(shard.deviceId, shard.bucket);
    // A newer undecryptable aggregate head may contain facts absent from the
    // readable union. Never consolidate that coordinate until it decrypts.
    if (decoded.unreadable.has(identifier)) continue;
    const serialized = serializeDmConversationIndexShard(shard);
    const targets = answeredRelays.filter((relay) => {
      const read = relayReads.get(relay);
      if (!read || read.unreadable.has(identifier)) return false;
      const remote = read.heads.get(identifier)?.shard;
      return !remote || serializeDmConversationIndexShard(remote) !== serialized;
    });
    if (targets.length === 0) continue;
    repairs.set(identifier, {
      shard,
      previous: decoded.heads.get(identifier)?.event,
      relays: targets,
    });
  }
  return repairs;
}

async function dmConversationIndexRelayRepairPlan(
  pubkey: string,
  answeredRelays: readonly string[],
  relayReads: ReadonlyMap<
    string,
    Pick<DecodedDmConversationIndex, "heads" | "unreadable">
  >,
): Promise<{ targets: Map<number, string[]>; blockedBuckets: Set<number> }> {
  const deviceId = dmConversationDeviceId(pubkey);
  const ownShards = await loadOwnDmConversationIndexShards(pubkey);
  const targets = new Map<number, string[]>();
  const blockedBuckets = new Set<number>();

  for (const read of relayReads.values()) {
    for (const identifier of read.unreadable) {
      const coordinate = parseDmConversationIndexDTag(identifier);
      if (coordinate?.deviceId === deviceId) blockedBuckets.add(coordinate.bucket);
    }
  }
  for (const relay of answeredRelays) {
    const read = relayReads.get(relay);
    // A missing relay-local decode is not proof of an empty relay. Fail closed.
    if (!read) continue;
    for (const shard of ownShards) {
      if (shard.records.length === 0 || blockedBuckets.has(shard.bucket)) continue;
      const identifier = dmConversationIndexDTag(deviceId, shard.bucket);
      const remote = read.heads.get(identifier)?.shard;
      if (
        remote
        && serializeDmConversationIndexShard(remote) === serializeDmConversationIndexShard(shard)
      ) continue;
      const held = targets.get(shard.bucket) ?? [];
      held.push(relay);
      targets.set(shard.bucket, held);
    }
  }
  return { targets, blockedBuckets };
}

/** Valid decryptions are immutable by event id and safe to reuse on invalidation. */
const decodedEventCache = new Map<string, DmConversationIndexShard>();
const MAX_DECODE_CACHE = 256;

/**
 * Relay results cross a trust boundary and must carry a valid signature.
 * ArmadaDB rumors are admitted only after verified ingest and deliberately
 * have their signature stripped; a cached item that still has a signature is
 * rechecked too, so a malformed signed row never wins a coordinate.
 */
export function verifiedDmConversationIndexEvents(
  remote: readonly NostrEvent[],
  cached: readonly NostrRumor[],
): NostrRumor[] {
  const byId = new Map<string, NostrRumor>();
  for (const event of cached) {
    if (!isSigned(event) || verifyEventOnce(event)) byId.set(event.id, event);
  }
  for (const event of remote) {
    if (verifyEventOnce(event)) byId.set(event.id, event);
  }
  return [...byId.values()];
}

function dTag(event: NostrRumor): string | undefined {
  return event.tags.find((tag) => tag[0] === "d")?.[1];
}

function rememberDecoded(event: NostrRumor, shard: DmConversationIndexShard): void {
  decodedEventCache.set(event.id, shard);
  while (decodedEventCache.size > MAX_DECODE_CACHE) {
    const oldest = decodedEventCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    decodedEventCache.delete(oldest);
  }
}

/**
 * Decrypt at most one winner per bounded installation coordinate. This runs
 * sequentially so a remote signer sees one request at a time rather than a
 * burst of simultaneous approval prompts.
 */
export async function decodeDmConversationIndexEvents(
  events: readonly NostrRumor[],
  signer: NostrSigner,
  pubkey: string,
): Promise<DecodedDmConversationIndex> {
  const heads = new Map<string, { event: NostrRumor; shard: DmConversationIndexShard }>();
  const unreadable = new Set<string>();
  const decodedShards: DmConversationIndexShard[] = [];
  if (!signer.nip44) return { shards: [], heads, unreadable };

  for (const editions of dmConversationIndexEventGroups(events, pubkey)) {
    const head = editions[0]!;
    const identifier = dTag(head);
    if (!identifier) continue;
    const coordinate = parseDmConversationIndexDTag(identifier);
    if (!coordinate) continue;
    const valid: DmConversationIndexShard[] = [];
    let headShard: DmConversationIndexShard | undefined;
    for (const event of editions) {
      let shard = decodedEventCache.get(event.id);
      if (!shard) {
        try {
          const plaintext = await signer.nip44.decrypt(pubkey, event.content);
          shard = parseDmConversationIndexPlaintext(plaintext) ?? undefined;
        } catch {
          shard = undefined;
        }
        if (shard) rememberDecoded(event, shard);
      }
      if (!shard || identifier !== dmConversationIndexDTag(shard.deviceId, shard.bucket)) continue;
      valid.push(shard);
      if (event.id === head.id) headShard = shard;
    }
    if (!headShard) {
      unreadable.add(identifier);
    }
    if (valid.length === 0) continue;
    const shard = fitDmConversationIndexShard(
      coordinate.deviceId,
      coordinate.bucket,
      mergeDmConversationIndexRecords(valid.map((edition) => edition.records)),
    );
    decodedShards.push(shard);
    // `heads` is the actual NIP-01 winner, not the semantic union above. The
    // distinction is what makes a newer partial head compare dirty against
    // the hydrated A∪B local shard and triggers a consolidating rewrite.
    if (headShard) heads.set(identifier, { event: head, shard: headShard });
    // Even when the newest edition is unreadable, an older valid edition is a
    // safe discovery hint. `unreadable` still blocks replacing the coordinate.
  }
  return { shards: decodedShards, heads, unreadable };
}

/** Shared by cold login, explicit Pull and the standing sync owner. */
export async function decodeAndHydrateDmConversationIndex(
  events: readonly NostrRumor[],
  signer: NostrSigner,
  pubkey: string,
): Promise<DecodedDmConversationIndex> {
  const decoded = await decodeDmConversationIndexEvents(events, signer, pubkey);
  await hydrateDmConversationIndexShards(pubkey, decoded.shards);
  return decoded;
}

/**
 * Build consolidation editions for an explicit Setup Sync. Every readable
 * divergent coordinate is repaired to its semantic union before the caller
 * fans state to a new relay set; otherwise a departed device's newer partial
 * head would permanently discard facts held only by an older relay copy.
 * Local buckets from this installation are included too.
 */
export async function signCurrentDmConversationIndexEvents(
  remoteEvents: readonly NostrRumor[],
  signer: NostrSigner,
  pubkey: string,
): Promise<NostrEvent[]> {
  if (!signer.nip44) {
    const hasLocalRecords = (await loadOwnDmConversationIndexShards(pubkey))
      .some((shard) => shard.records.length > 0);
    if (remoteEvents.length === 0 && !hasLocalRecords) return [];
    throw new Error("Your signer cannot encrypt the DM conversation index");
  }
  // Relay editions arrive signed and are verified at this boundary. ArmadaDB
  // intentionally strips signatures after verified ingest; retain those
  // trusted cached rumors as semantic inputs so an Android-background update
  // cannot disappear during a relay rotation.
  const verified = verifiedDmConversationIndexEvents(
    remoteEvents.filter(isSigned),
    remoteEvents.filter((event) => !isSigned(event)),
  );
  const decoded = await decodeAndHydrateDmConversationIndex(verified, signer, pubkey);
  const deviceId = dmConversationDeviceId(pubkey);
  if (decoded.unreadable.size > 0) {
    throw new Error("An existing DM conversation index shard could not be decrypted");
  }

  const signed: NostrEvent[] = [];
  const repaired = new Set<string>();
  const signShard = async (
    shard: DmConversationIndexShard,
    previous: NostrRumor | undefined,
  ): Promise<void> => {
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      (previous?.created_at ?? 0) + 1,
    );
    const publishedAt = previous?.tags.find(([name]) => name === "published_at")?.[1]
      ?? String(createdAt);
    const event = await signer.signEvent({
      kind: DM_CONVERSATIONS_EVENT_KIND,
      content: await signer.nip44!.encrypt(
        pubkey,
        serializeDmConversationIndexShard(shard),
      ),
      tags: [
        ["d", dmConversationIndexDTag(shard.deviceId, shard.bucket)],
        ["t", DM_CONVERSATIONS_EVENT_TAG],
        ["published_at", publishedAt],
        ["client", APP_NAME],
      ],
      created_at: createdAt,
    });
    if (event.pubkey !== pubkey) throw new Error("The signer returned a different account");
    signed.push(event);
  };

  // Repair EVERY divergent remote coordinate, not only this installation's.
  // An old device may never return to rewrite its own d-tag, while Setup Sync
  // is precisely the operation that migrates those records to a new relay set.
  for (const merged of [...decoded.shards].sort((a, b) =>
    dmConversationIndexDTag(a.deviceId, a.bucket)
      .localeCompare(dmConversationIndexDTag(b.deviceId, b.bucket)))) {
    const identifier = dmConversationIndexDTag(merged.deviceId, merged.bucket);
    const head = decoded.heads.get(identifier);
    if (!head) continue;
    if (serializeDmConversationIndexShard(head.shard) === serializeDmConversationIndexShard(merged)) {
      continue;
    }
    await signShard(merged, head.event);
    repaired.add(identifier);
  }

  const remoteOwn = new Map<number, DmConversationIndexShard>();
  const previousByBucket = new Map<number, NostrRumor>();
  for (const { event, shard } of decoded.heads.values()) {
    if (shard.deviceId !== deviceId) continue;
    remoteOwn.set(shard.bucket, shard);
    previousByBucket.set(shard.bucket, event);
  }
  const dirtyBuckets = await ownDmConversationIndexNeedsPublish(pubkey, remoteOwn);
  const local = new Map(
    (await loadOwnDmConversationIndexShards(pubkey)).map((shard) => [shard.bucket, shard]),
  );
  for (const bucket of dirtyBuckets.sort((a, b) => a - b)) {
    const shard = local.get(bucket);
    if (!shard || shard.records.length === 0) continue;
    const identifier = dmConversationIndexDTag(deviceId, bucket);
    if (repaired.has(identifier)) continue;
    const previous = previousByBucket.get(bucket);
    await signShard(shard, previous);
  }
  return signed;
}

/**
 * Always-mounted, noninteractive discovery recorder. It sees both DM planes
 * even when the user never opens DMs, but never decrypts NIP-04 previews or
 * requests interactive NIP-17 approval. Trust has fully settled before any
 * real, main-inbox row is admitted to the local shard.
 */
export function useRecordDmConversationIndex(): void {
  const { user } = useCurrentUser();
  const { conversations: nip04, isLoading: nip04Loading } = useDMConversations({
    decryptPreviews: false,
  });
  const { conversations: nip17, isLoading: nip17Loading } = useDm17Conversations({
    interactive: false,
  });
  const { isKnown, isLoading: trustLoading } = useKnownDmPeers();

  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!pubkey || nip04Loading || nip17Loading || trustLoading) return;
    const records = [
      ...nip04.flatMap((conversation) => isKnown(conversation.peer, conversation.mine) ? [{
        key: conversation.peer,
        latest: {
          createdAt: conversation.latest.created_at,
          id: conversation.latest.id,
        },
        mine: conversation.mine,
      }] : []),
      ...nip17.flatMap((conversation) =>
        conversation.peers.every((peer) => isKnown(peer, conversation.mine)) ? [{
          key: conversation.key,
          latest: {
            createdAt: conversation.latest.createdAt,
            id: conversation.latest.rumorId,
          },
          mine: conversation.mine,
        }] : []),
    ];
    if (records.length === 0) return;
    const timer = setTimeout(() => void recordDmConversationIndex(pubkey, records), 800);
    return () => clearTimeout(timer);
  }, [isKnown, nip04, nip04Loading, nip17, nip17Loading, trustLoading, user?.pubkey]);
}

/**
 * Network owner for the encrypted, per-installation DM conversation roster.
 * Automatic settings sync is the consent gate; explicit portable Pull/Sync
 * call the pure helper above and remain available while the gate is off.
 */
export function useDmConversationIndexSync(): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const automaticSettingsSync = config.automaticSettingsSync !== false;
  const relayKey = selfStateRelays(config, user?.pubkey).sort().join("\u0000");
  const relays = useMemo(
    () => relayKey ? relayKey.split("\u0000") : [],
    [relayKey],
  );
  const nip65WriteRelayKey = config.relayMetadata.pubkey === user?.pubkey
    ? [...new Set(config.relayMetadata.relays
      .filter((relay) => relay.write)
      .map((relay) => normalizeRelayUrl(relay.url))
      .filter((relay): relay is string => relay !== undefined))]
      .sort()
      .join("\u0000")
    : "";
  const nip65WriteRelays = useMemo(
    () => nip65WriteRelayKey ? nip65WriteRelayKey.split("\u0000") : [],
    [nip65WriteRelayKey],
  );
  // Prefer current NIP-65 write declarations. Accounts without an owned
  // kind-10002 still need a bootstrap authority, so their explicitly selected
  // self-state/app relays form the canonical set until a pointer exists.
  const canonicalSourceRelays = nip65WriteRelays.length > 0 ? nip65WriteRelays : relays;
  const canAutomaticallySync = automaticSettingsSync
    && !!user?.pubkey
    && !!user.signer.nip44
    && relays.length > 0
    && canonicalSourceRelays.some((relay) => relays.includes(relay));
  const syncBaseKey = user?.pubkey && relayKey
    ? `${user.pubkey}\u0001${relayKey}\u0002${nip65WriteRelayKey}`
    : undefined;
  const activeBaseKeyRef = useRef(syncBaseKey);
  activeBaseKeyRef.current = syncBaseKey;
  const pulledForBaseKey = useRef<string | undefined>(undefined);
  const ownEventsRef = useRef<Map<number, NostrRumor>>(new Map());
  const lastCreatedAtRef = useRef<Map<number, number>>(new Map());
  const lastSignedFingerprintRef = useRef<Map<number, string>>(new Map());
  const blockedBucketsRef = useRef<Set<number>>(new Set());
  const publishRelaysRef = useRef<string[]>([]);
  const publishChain = useRef<Promise<unknown>>(Promise.resolve());
  const departedCreatedAtRef = useRef<Map<string, number>>(new Map());
  const departedRepairGenerationRef = useRef(0);
  const publishBucketsRef = useRef<(
    buckets: readonly number[],
    relayTargets?: DmConversationIndexRelayTargets,
  ) => Promise<number[]>>(async (buckets) => [...buckets]);
  // `null` means retry against the current completed cohort; a Set preserves
  // the exact relay scope of a per-relay repair failure.
  const retryBucketsRef = useRef<Map<number, Set<string> | null>>(new Map());
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const syncEnabledRef = useRef(false);

  const query = useQuery({
    queryKey: [
      ...DM_CONVERSATIONS_SYNC_QUERY_KEY,
      user?.pubkey,
      relayKey,
      nip65WriteRelayKey,
    ],
    enabled: canAutomaticallySync,
    queryFn: async ({ signal }) => {
      if (!user?.signer.nip44) {
        return {
          shards: [],
          heads: new Map(),
          unreadable: new Set(),
          baseKey: syncBaseKey ?? "",
          publishRelays: [],
          relayReads: new Map(),
          repairTargets: new Map(),
          departedRepairs: new Map(),
          repairPending: false,
        } satisfies DmConversationIndexPull;
      }
      // Never let queryExplicitRelays' general-pool fallback widen this private
      // self-state read. An empty target set is an unavailable sync, not a pool query.
      if (relays.length === 0) throw new Error("No self-state relays configured");
      const filter = dmConversationIndexFilter(user.pubkey);
      const store = await eventStore;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
      const [settled, cached] = await Promise.all([
        Promise.allSettled(
          relays.map((relay) => nostr.relay(relay).query([filter], { signal: deadline })),
        ),
        store.query([filter]).catch(() => []),
      ]);
      const completed = settled.flatMap((result, index) => result.status === "fulfilled" ? [{
        relay: relays[index]!,
        events: result.value,
      }] : []);
      const failedRelays = settled.flatMap((result, index) =>
        result.status === "rejected" ? [relays[index]!] : []);
      if (completed.length === 0) throw new Error("No self-state relay completed the DM index pull");
      const remote = completed.flatMap((result) => result.events);
      const decoded = await decodeAndHydrateDmConversationIndex(
        verifiedDmConversationIndexEvents(remote, cached),
        user.signer,
        user.pubkey,
      );
      // App relays can contribute discovery, but only the account's signed
      // NIP-65 write set establishes authority for a portable-state rewrite.
      // Unanswered relays are deliberately absent from `publishRelays`: they
      // may hold a richer divergent edition and must not receive this round's
      // replacement until they have participated in a later merge.
      const completedRelays = completed.map(({ relay }) => relay);
      const relayReads = new Map<
        string,
        Pick<DecodedDmConversationIndex, "heads" | "unreadable">
      >();
      // Decode the aggregate first so valid editions enter the immutable
      // cache. The relay-local passes below then retain provenance without a
      // second signer prompt for the same event.
      for (const { relay, events } of completed) {
        const relayDecoded = await decodeDmConversationIndexEvents(
          verifiedDmConversationIndexEvents(events, []),
          user.signer,
          user.pubkey,
        );
        relayReads.set(relay, {
          heads: relayDecoded.heads,
          unreadable: relayDecoded.unreadable,
        });
      }
      // One unreadable relay-local coordinate means that relay's current state
      // was not fully observed. It remains a read/repair obligation but cannot
      // join any write cohort until a later clean read.
      const safeCompletedRelays = completedRelays.filter(
        (relay) => relayReads.get(relay)?.unreadable.size === 0,
      );
      if (!safeCompletedRelays.some((relay) => canonicalSourceRelays.includes(relay))) {
        throw new Error("A declared NIP-65 write relay must complete a readable DM index pull");
      }
      // Hydration above merged every answered edition before this comparison.
      // A returning richer relay can therefore widen the desired own shard;
      // it is never overwritten with the shorter pre-read copy.
      const repair = await dmConversationIndexRelayRepairPlan(
        user.pubkey,
        safeCompletedRelays,
        relayReads,
      );
      const departedRepairs = dmConversationIndexDepartedRepairPlan(
        decoded,
        dmConversationDeviceId(user.pubkey),
        safeCompletedRelays,
        relayReads,
      );
      return {
        ...decoded,
        baseKey: syncBaseKey!,
        publishRelays: safeCompletedRelays,
        relayReads,
        repairTargets: repair.targets,
        departedRepairs,
        repairPending: failedRelays.length > 0
          || safeCompletedRelays.length < completedRelays.length
          || decoded.unreadable.size > 0
          || repair.targets.size > 0
          || departedRepairs.size > 0
          || repair.blockedBuckets.size > 0,
      } satisfies DmConversationIndexPull;
    },
    staleTime: 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });
  const pulledBaseKey = query.data?.baseKey;
  const pullRepairPending = query.data?.repairPending ?? false;
  const pullUpdatedAt = query.dataUpdatedAt;
  const pullFetchStatus = query.fetchStatus;
  const refetchPull = query.refetch;

  // React Query's normal retries are intentionally finite. Keep one bounded
  // retry outstanding while the base is missing or a relay-local repair still
  // needs read-back confirmation; a healthy sync performs no polling.
  useEffect(() => {
    if (
      !canAutomaticallySync
      || !syncBaseKey
      || (pulledBaseKey === syncBaseKey && !pullRepairPending)
      || pullFetchStatus !== "idle"
    ) return;
    const timer = setTimeout(() => {
      void refetchPull();
    }, DM_CONVERSATION_INDEX_PULL_RETRY_MS);
    return () => clearTimeout(timer);
  }, [
    canAutomaticallySync,
    pulledBaseKey,
    pullRepairPending,
    pullUpdatedAt,
    pullFetchStatus,
    refetchPull,
    syncBaseKey,
  ]);

  const publishCurrentBuckets = useCallback((
    requestedBuckets: readonly number[],
    relayTargets?: DmConversationIndexRelayTargets,
  ): Promise<number[]> => {
    const buckets = [...new Set(requestedBuckets)].sort((a, b) => a - b);
    const run = async (): Promise<number[]> => {
      const pubkey = user?.pubkey;
      const nip44 = user?.signer.nip44;
      const baseKey = syncBaseKey;
      if (
        !automaticSettingsSync
        || !pubkey
        || !nip44
        || relays.length === 0
        || !baseKey
      ) return buckets;
      if (pulledForBaseKey.current !== baseKey) return buckets;
      const publishRelays = publishRelaysRef.current;
      if (publishRelays.length === 0) return buckets;
      const allowedRelays = new Set(publishRelays);

      const byBucket = new Map(
        (await loadOwnDmConversationIndexShards(pubkey)).map((shard) => [shard.bucket, shard]),
      );
      const failed: number[] = [];
      // One stable bucket per event avoids rewrite conflicts. Sequential
      // signing keeps a remote signer from receiving simultaneous prompts.
      for (const bucket of buckets) {
        if (activeBaseKeyRef.current !== baseKey) {
          failed.push(bucket);
          continue;
        }
        if (blockedBucketsRef.current.has(bucket)) {
          failed.push(bucket);
          continue;
        }
        const shard = byBucket.get(bucket);
        if (!shard || shard.records.length === 0) continue;
        const hasExactTargets = relayTargets?.has(bucket) ?? false;
        const targetRelays = hasExactTargets
          ? [...new Set(relayTargets?.get(bucket) ?? [])]
            .filter((relay) => allowedRelays.has(relay))
          : publishRelays;
        if (targetRelays.length === 0) {
          failed.push(bucket);
          continue;
        }
        const plaintext = serializeDmConversationIndexShard(shard);
        // Aggregate equality can conceal an empty/stale answered relay. Exact
        // repair targets deliberately bypass the global clean fingerprint.
        if (!hasExactTargets && lastSignedFingerprintRef.current.get(bucket) === plaintext) continue;
        let content: string;
        try {
          content = await nip44.encrypt(pubkey, plaintext);
        } catch (error) {
          console.warn("Failed to encrypt DM conversation index:", error);
          failed.push(bucket);
          continue;
        }
        if (activeBaseKeyRef.current !== baseKey) {
          failed.push(bucket);
          continue;
        }
        const now = Math.floor(Date.now() / 1000);
        const previous = ownEventsRef.current.get(bucket);
        const createdAt = Math.max(
          now,
          (lastCreatedAtRef.current.get(bucket) ?? 0) + 1,
          (previous?.created_at ?? 0) + 1,
        );
        lastCreatedAtRef.current.set(bucket, createdAt);

        try {
          await publishEvent({
            kind: DM_CONVERSATIONS_EVENT_KIND,
            content,
            tags: [
              ["d", dmConversationIndexDTag(shard.deviceId, bucket)],
              ["t", DM_CONVERSATIONS_EVENT_TAG],
            ],
            created_at: createdAt,
            prev: previous,
            relays: targetRelays,
            inheritPendingTargets: false,
            onSigned: (event: NostrEvent) => {
              if (activeBaseKeyRef.current !== baseKey) return;
              ownEventsRef.current.set(bucket, event);
              lastSignedFingerprintRef.current.set(bucket, plaintext);
            },
          });
        } catch (error) {
          // A queued event retains its exact explicit relay targets. Signer
          // refusal leaves the local bucket dirty for a later pull.
          if (!isPublishQueuedError(error)) {
            // onSigned runs before the relay attempt. Undo its clean marker
            // when neither delivery nor a durable outbox entry is guaranteed.
            lastSignedFingerprintRef.current.delete(bucket);
            console.warn("Failed to sync DM conversation index:", error);
            failed.push(bucket);
          }
        }
      }
      return failed;
    };

    const next = publishChain.current.then(run, run);
    publishChain.current = next;
    return next;
  }, [automaticSettingsSync, publishEvent, relays.length, syncBaseKey, user]);

  const publishDepartedRepairs = useCallback((
    repairs: ReadonlyMap<string, DmConversationIndexCoordinateRepair>,
    generation: number,
    isCancelled: () => boolean,
  ): Promise<void> => {
    const run = async (): Promise<void> => {
      const pubkey = user?.pubkey;
      const nip44 = user?.signer.nip44;
      const baseKey = syncBaseKey;
      if (
        !automaticSettingsSync
        || !pubkey
        || !nip44
        || !baseKey
        || isCancelled()
        || pulledForBaseKey.current !== baseKey
        || departedRepairGenerationRef.current !== generation
      ) return;
      const allowedRelays = new Set(publishRelaysRef.current);
      for (const [identifier, repair] of repairs) {
        if (
          activeBaseKeyRef.current !== baseKey
          || isCancelled()
          || departedRepairGenerationRef.current !== generation
        ) return;
        const targetRelays = [...new Set(repair.relays)]
          .filter((relay) => allowedRelays.has(relay));
        if (targetRelays.length === 0) continue;
        const plaintext = serializeDmConversationIndexShard(repair.shard);
        let content: string;
        try {
          content = await nip44.encrypt(pubkey, plaintext);
        } catch (error) {
          console.warn("Failed to encrypt departed DM conversation index shard:", error);
          continue;
        }
        if (
          activeBaseKeyRef.current !== baseKey
          || isCancelled()
          || departedRepairGenerationRef.current !== generation
        ) return;
        const createdAt = Math.max(
          Math.floor(Date.now() / 1000),
          (repair.previous?.created_at ?? 0) + 1,
          (departedCreatedAtRef.current.get(identifier) ?? 0) + 1,
        );
        departedCreatedAtRef.current.set(identifier, createdAt);
        try {
          await publishEvent({
            kind: DM_CONVERSATIONS_EVENT_KIND,
            content,
            tags: [
              ["d", identifier],
              ["t", DM_CONVERSATIONS_EVENT_TAG],
            ],
            created_at: createdAt,
            prev: repair.previous,
            relays: targetRelays,
            inheritPendingTargets: false,
          });
        } catch (error) {
          // Queued failures retain these exact read-authorized targets. An
          // unqueued failure remains repairPending and is replanned next pull.
          if (!isPublishQueuedError(error)) {
            console.warn("Failed to repair departed DM conversation index shard:", error);
          }
        }
      }
    };
    const next = publishChain.current.then(run, run);
    publishChain.current = next;
    return next;
  }, [automaticSettingsSync, publishEvent, syncBaseKey, user]);

  publishBucketsRef.current = publishCurrentBuckets;
  syncEnabledRef.current = canAutomaticallySync;

  const scheduleRetry = useCallback((
    buckets: readonly number[],
    relayTargets?: DmConversationIndexRelayTargets,
  ) => {
    const enqueue = (bucket: number, exactTargets?: readonly string[]) => {
      const pending = retryBucketsRef.current;
      if (!exactTargets) {
        // A general local edit supersedes any narrower repair for this bucket.
        pending.set(bucket, null);
        return;
      }
      if (pending.has(bucket) && pending.get(bucket) === null) return;
      const held = pending.get(bucket) ?? new Set<string>();
      for (const relay of exactTargets) held.add(relay);
      pending.set(bucket, held);
    };
    for (const bucket of buckets) {
      enqueue(bucket, relayTargets?.has(bucket) ? relayTargets.get(bucket) : undefined);
    }
    if (buckets.length === 0 || retryTimerRef.current || !syncEnabledRef.current) return;
    const retry = async () => {
      retryTimerRef.current = undefined;
      if (!syncEnabledRef.current) return;
      const pending = new Map(retryBucketsRef.current);
      retryBucketsRef.current.clear();
      const general: number[] = [];
      const exact = new Map<number, string[]>();
      for (const [bucket, targets] of pending) {
        if (targets === null) general.push(bucket);
        else exact.set(bucket, [...targets]);
      }
      const generalFailed = await publishBucketsRef.current(general);
      const exactFailed = await publishBucketsRef.current([...exact.keys()], exact);
      for (const bucket of generalFailed) enqueue(bucket);
      for (const bucket of exactFailed) enqueue(bucket, exact.get(bucket));
      if (retryBucketsRef.current.size > 0 && syncEnabledRef.current) {
        retryTimerRef.current = setTimeout(() => void retry(), DM_CONVERSATION_INDEX_RETRY_MS);
      }
    };
    retryTimerRef.current = setTimeout(() => void retry(), DM_CONVERSATION_INDEX_RETRY_MS);
  }, []);

  useEffect(() => {
    pulledForBaseKey.current = undefined;
    ownEventsRef.current = new Map();
    lastCreatedAtRef.current = new Map();
    lastSignedFingerprintRef.current = new Map();
    departedCreatedAtRef.current = new Map();
    departedRepairGenerationRef.current++;
    blockedBucketsRef.current = new Set();
    publishRelaysRef.current = [];
    retryBucketsRef.current.clear();
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
  }, [syncBaseKey]);

  // A completed canonical pull establishes the publication base. Relay-local
  // provenance then narrows each repair to copies proven stale or empty. A
  // local edit racing the pull widens only its bucket to the answered cohort.
  useEffect(() => {
    const pubkey = user?.pubkey;
    const baseKey = syncBaseKey;
    const pull = query.data;
    if (
      !automaticSettingsSync
      || !pubkey
      || !baseKey
      || !pull
      || pull.baseKey !== baseKey
    ) return;
    let cancelled = false;
    const repairGeneration = ++departedRepairGenerationRef.current;
    const ownDeviceId = dmConversationDeviceId(pubkey);
    const remoteOwn = new Map<number, DmConversationIndexShard>();
    blockedBucketsRef.current = new Set(
      [...pull.unreadable]
        .map(parseDmConversationIndexDTag)
        .filter((coordinate) => coordinate?.deviceId === ownDeviceId)
        .map((coordinate) => coordinate!.bucket),
    );
    for (const { event, shard } of pull.heads.values()) {
      if (shard.deviceId !== ownDeviceId) continue;
      remoteOwn.set(shard.bucket, shard);
      ownEventsRef.current.set(shard.bucket, event);
      lastCreatedAtRef.current.set(
        shard.bucket,
        Math.max(lastCreatedAtRef.current.get(shard.bucket) ?? 0, event.created_at),
      );
      lastSignedFingerprintRef.current.set(
        shard.bucket,
        serializeDmConversationIndexShard(shard),
      );
    }
    publishRelaysRef.current = pull.publishRelays;
    pulledForBaseKey.current = baseKey;
    void ownDmConversationIndexNeedsPublish(pubkey, remoteOwn).then(async (dirtyBuckets) => {
      if (cancelled) return;
      const targets = new Map<number, string[]>(
        [...pull.repairTargets].map(([bucket, relays]) => [bucket, [...relays]]),
      );
      for (const bucket of dirtyBuckets) targets.set(bucket, [...pull.publishRelays]);

      // A confirming read cancels only obsolete exact-repair retries. General
      // local-edit retries remain until their own publish succeeds.
      for (const [bucket, pending] of retryBucketsRef.current) {
        if (pending === null) continue;
        const stillNeeded = new Set(targets.get(bucket) ?? []);
        for (const relay of pending) {
          if (!stillNeeded.has(relay)) pending.delete(relay);
        }
        if (pending.size === 0) retryBucketsRef.current.delete(bucket);
      }
      if (retryBucketsRef.current.size === 0 && retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = undefined;
      }

      if (targets.size > 0) {
        const failed = await publishCurrentBuckets([...targets.keys()], targets);
        scheduleRetry(failed, targets);
      }
      if (!cancelled && pull.departedRepairs.size > 0) {
        await publishDepartedRepairs(
          pull.departedRepairs,
          repairGeneration,
          () => cancelled,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    automaticSettingsSync,
    publishDepartedRepairs,
    publishCurrentBuckets,
    query.data,
    scheduleRetry,
    syncBaseKey,
    user?.pubkey,
  ]);

  // Settled inbox changes update local state immediately; this subscription
  // only schedules the encrypted rewrite and collapses a message burst.
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!automaticSettingsSync || !pubkey || !user.signer.nip44) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pendingBuckets = new Set<number>();
    const unsubscribe = subscribeDmConversationIndexChanges((changedPubkey, buckets) => {
      if (
        changedPubkey !== pubkey
        || !syncBaseKey
        || pulledForBaseKey.current !== syncBaseKey
      ) return;
      for (const bucket of buckets) pendingBuckets.add(bucket);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const scheduled = [...pendingBuckets];
        pendingBuckets.clear();
        void publishCurrentBuckets(scheduled).then(scheduleRetry);
      }, DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [automaticSettingsSync, publishCurrentBuckets, scheduleRetry, syncBaseKey, user]);

  useEffect(() => () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);
}

export const dmConversationIndexSyncQueryKey = DM_CONVERSATIONS_SYNC_QUERY_KEY;

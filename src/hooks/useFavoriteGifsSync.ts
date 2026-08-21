import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { verifyEvent } from "nostr-tools/pure";

import { selfStateRelays } from "@/contexts/AppContext";
import {
  claimLegacyFavoriteGifs,
  completeLegacyFavoriteGifMigration,
  FAVORITE_GIFS_D_PREFIX,
  FAVORITE_GIFS_EVENT_KIND,
  FAVORITE_GIFS_EVENT_TAG,
  getFavoriteGifShardDTag,
  hydrateFavoriteGifShards,
  loadOwnFavoriteGifShard,
  mergeFavoriteGifRecords,
  parseFavoriteGifShard,
  readyFavoriteGifShards,
  subscribeFavoriteGifChanges,
  type FavoriteGifShard,
} from "@/hooks/useFavoriteGifs";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { isSigned } from "@/lib/nostrRumor";
import { isPublishQueuedError } from "@/lib/publishOutbox";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

const QUERY_KEY = "favorite-gifs-sync";
export const FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS = 400;

function favoriteGifFilter(pubkey: string): NostrFilter {
  return {
    kinds: [FAVORITE_GIFS_EVENT_KIND],
    authors: [pubkey],
    "#t": [FAVORITE_GIFS_EVENT_TAG],
  };
}

function dTag(event: NostrRumor): string | undefined {
  return event.tags.find((tag) => tag[0] === "d")?.[1];
}

/** NIP-01 addressable tie-break: newer timestamp, then lowest event id. */
function eventWins(candidate: NostrRumor, current: NostrRumor | undefined): boolean {
  return !current
    || candidate.created_at > current.created_at
    || (candidate.created_at === current.created_at && candidate.id < current.id);
}

export async function decodeFavoriteGifEvents(
  pubkey: string,
  decrypt: (pubkey: string, content: string) => Promise<string>,
  events: NostrRumor[],
): Promise<{
  shards: FavoriteGifShard[];
  ownEvents: Map<string, NostrRumor>;
  heads: Map<string, { event: NostrRumor; shard: FavoriteGifShard }>;
  unreadable: Set<string>;
}> {
  const editions = new Map<string, NostrRumor[]>();
  for (const event of events) {
    const identifier = dTag(event);
    if (
      event.kind !== FAVORITE_GIFS_EVENT_KIND
      || event.pubkey !== pubkey
      || !event.tags.some(([name, value]) => name === "t" && value === FAVORITE_GIFS_EVENT_TAG)
      || !identifier?.startsWith(FAVORITE_GIFS_D_PREFIX)
    ) continue;
    const held = editions.get(identifier) ?? [];
    if (!held.some((candidate) => candidate.id === event.id)) held.push(event);
    editions.set(identifier, held);
  }

  const shards: FavoriteGifShard[] = [];
  const ownEvents = new Map<string, NostrRumor>();
  const heads = new Map<string, { event: NostrRumor; shard: FavoriteGifShard }>();
  const unreadable = new Set<string>();
  for (const [identifier, candidates] of editions) {
    candidates.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    const head = candidates[0]!;
    let headReadable = false;
    let headShard: FavoriteGifShard | undefined;
    // Divergent relay copies are CRDT inputs, not alternatives: retain every
    // valid edition's operations while using only NIP-01's winner as `prev`.
    for (const event of candidates.slice(0, 32)) {
      try {
        const plaintext = await decrypt(pubkey, event.content);
        const shard = parseFavoriteGifShard(JSON.parse(plaintext));
        if (!shard || identifier !== `${FAVORITE_GIFS_D_PREFIX}${shard.deviceId}`) continue;
        shards.push(shard);
        if (event.id === head.id) {
          headReadable = true;
          headShard = shard;
        }
      } catch {
        // A different relay's edition can still recover this coordinate.
      }
    }
    if (headReadable && headShard) {
      ownEvents.set(identifier, head);
      heads.set(identifier, { event: head, shard: headShard });
    }
    else unreadable.add(identifier);
  }
  return { shards, ownEvents, heads, unreadable };
}

/**
 * Build consolidation editions for explicit Setup Sync. Every readable
 * divergent installation coordinate is repaired before relay migration; an
 * old device may never come back to rewrite its own partial head. This
 * installation's local shard is included as well.
 */
export async function signCurrentFavoriteGifEvents(
  remoteEvents: readonly NostrRumor[],
  signer: NostrSigner,
  pubkey: string,
): Promise<NostrEvent[]> {
  await readyFavoriteGifShards();
  if (!signer.nip44) {
    if (remoteEvents.length === 0 && loadOwnFavoriteGifShard(pubkey).records.length === 0) return [];
    throw new Error("Your signer cannot encrypt GIF favorites");
  }
  // Network editions must verify. ArmadaDB rumors have had their signatures
  // stripped after verified ingest, but remain trusted semantic inputs during
  // an explicit relay migration.
  const verified = remoteEvents.filter((event) => !isSigned(event) || verifyEvent(event));
  const decoded = await decodeFavoriteGifEvents(
    pubkey,
    (author, content) => signer.nip44!.decrypt(author, content),
    verified,
  );
  hydrateFavoriteGifShards(pubkey, decoded.shards);

  if (decoded.unreadable.size > 0) {
    throw new Error("An existing GIF favorites shard could not be decrypted");
  }

  const signed: NostrEvent[] = [];
  const repaired = new Set<string>();
  const signShard = async (
    d: string,
    shard: FavoriteGifShard,
    previous: NostrRumor | undefined,
  ): Promise<void> => {
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      (previous?.created_at ?? 0) + 1,
    );
    const event = await signer.signEvent({
      kind: FAVORITE_GIFS_EVENT_KIND,
      content: await signer.nip44!.encrypt(pubkey, JSON.stringify(shard)),
      tags: [
        ["d", d],
        ["t", FAVORITE_GIFS_EVENT_TAG],
        ["title", "Armada GIF Favorites"],
      ],
      created_at: createdAt,
    });
    if (event.pubkey !== pubkey) throw new Error("The signer returned a different account");
    signed.push(event);
  };

  const shardsByDevice = new Map<string, FavoriteGifShard[]>();
  for (const shard of decoded.shards) {
    const held = shardsByDevice.get(shard.deviceId) ?? [];
    held.push(shard);
    shardsByDevice.set(shard.deviceId, held);
  }
  for (const [deviceId, editions] of [...shardsByDevice].sort(([a], [b]) => a.localeCompare(b))) {
    const d = `${FAVORITE_GIFS_D_PREFIX}${deviceId}`;
    const head = decoded.heads.get(d);
    if (!head) continue;
    const merged: FavoriteGifShard = {
      version: 1,
      deviceId,
      records: mergeFavoriteGifRecords(...editions.map((edition) => edition.records)),
    };
    if (JSON.stringify(head.shard.records) === JSON.stringify(merged.records)) continue;
    await signShard(d, merged, head.event);
    repaired.add(d);
  }

  const ownD = getFavoriteGifShardDTag(pubkey);
  const shard = loadOwnFavoriteGifShard(pubkey);
  if (shard.records.length === 0 || repaired.has(ownD)) return signed;
  const head = decoded.heads.get(ownD);
  if (head && JSON.stringify(head.shard.records) === JSON.stringify(shard.records)) return signed;
  await signShard(ownD, shard, head?.event);
  return signed;
}

/**
 * Encrypted sync for GIF favorites, gated by this installation's automatic
 * settings-sync preference. Each installation owns one addressable shard;
 * merging all shards gives add/remove convergence without one upgrading device
 * being able to replace another device's old favorites.
 */
export function useFavoriteGifsSync(): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const automaticSettingsSync = config.automaticSettingsSync !== false;
  const eventStore = useEventStore();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const relayKey = selfStateRelays(config, user?.pubkey).sort().join("\u0000");
  const relays = useMemo(() => relayKey ? relayKey.split("\u0000") : [], [relayKey]);
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
  // An owned kind-10002 is authoritative when it exists. Before an account
  // publishes one, the explicit self-state/app relay set is the only honest
  // bootstrap source; requiring a declared writer in that state would disable
  // sync entirely for existing accounts.
  const canonicalSourceRelays = nip65WriteRelays.length > 0 ? nip65WriteRelays : relays;
  const syncBaseKey = user?.pubkey && relayKey
    ? `${user.pubkey}\u0001${relayKey}\u0002${nip65WriteRelayKey}`
    : undefined;
  const activeBaseKeyRef = useRef(syncBaseKey);
  activeBaseKeyRef.current = syncBaseKey;
  const ownEventRef = useRef<NostrRumor | undefined>(undefined);
  const lastCreatedAtRef = useRef(0);
  const migrationInFlight = useRef(false);
  const publishChain = useRef<Promise<void>>(Promise.resolve());
  const pulledForBaseKey = useRef<string | undefined>(undefined);
  const publishRelaysRef = useRef<string[]>([]);
  const dirtyBeforePull = useRef(false);
  const previousAutomatic = useRef(automaticSettingsSync);
  const previousBaseKey = useRef(syncBaseKey);
  const previousPubkey = useRef(user?.pubkey);
  const blockedOwnRef = useRef(false);

  const queryKey = [QUERY_KEY, user?.pubkey, relayKey, nip65WriteRelayKey];
  const query = useQuery({
    queryKey,
    enabled: automaticSettingsSync
      && !!user?.pubkey
      && !!user.signer.nip44
      && relays.length > 0,
    queryFn: async ({ signal }) => {
      if (!user?.signer.nip44) {
        return {
          shards: [],
          ownEvents: new Map<string, NostrRumor>(),
          heads: new Map<string, { event: NostrRumor; shard: FavoriteGifShard }>(),
          unreadable: new Set<string>(),
          baseKey: syncBaseKey ?? "",
          publishRelays: [],
        };
      }
      const filter = favoriteGifFilter(user.pubkey);
      const store = await eventStore;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
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
      if (completed.length === 0) throw new Error("No self-state relay completed the GIF pull");
      const byId = new Map<string, NostrRumor>();
      for (const event of cached) {
        if (!isSigned(event) || verifyEvent(event)) byId.set(event.id, event);
      }
      for (const event of completed.flatMap(({ events }) => events)) {
        if (verifyEvent(event)) byId.set(event.id, event);
      }
      const decoded = await decodeFavoriteGifEvents(
        user.pubkey,
        (pubkey, content) => user.signer.nip44!.decrypt(pubkey, content),
        [...byId.values()],
      );
      hydrateFavoriteGifShards(user.pubkey, decoded.shards);
      const completedRelays = completed.map(({ relay }) => relay);
      if (!completedRelays.some((relay) => canonicalSourceRelays.includes(relay))) {
        throw new Error("A declared NIP-65 write relay must complete the GIF pull");
      }
      return { ...decoded, baseKey: syncBaseKey!, publishRelays: completedRelays };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });

  const publishCurrentShard = useCallback((completeMigration: boolean) => {
    const pubkey = user?.pubkey;
    const nip44 = user?.signer.nip44;
    const baseKey = syncBaseKey;
    if (
      !automaticSettingsSync
      || !pubkey
      || !nip44
      || !baseKey
      || pulledForBaseKey.current !== baseKey
    ) return Promise.resolve();

    const run = async () => {
      const publishRelays = publishRelaysRef.current;
      if (
        activeBaseKeyRef.current !== baseKey
        || publishRelays.length === 0
        || blockedOwnRef.current
      ) return;
      const shard = loadOwnFavoriteGifShard(pubkey);
      if (shard.records.length === 0) {
        if (completeMigration) completeLegacyFavoriteGifMigration();
        return;
      }
      const content = await nip44.encrypt(pubkey, JSON.stringify(shard));
      if (activeBaseKeyRef.current !== baseKey) return;
      const now = Math.floor(Date.now() / 1000);
      const previous = ownEventRef.current;
      const createdAt = Math.max(now, lastCreatedAtRef.current + 1, (previous?.created_at ?? 0) + 1);
      lastCreatedAtRef.current = createdAt;

      try {
        await publishEvent({
          kind: FAVORITE_GIFS_EVENT_KIND,
          content,
          tags: [
            ["d", getFavoriteGifShardDTag(pubkey)],
            ["t", FAVORITE_GIFS_EVENT_TAG],
            ["title", "Armada GIF Favorites"],
          ],
          created_at: createdAt,
          prev: previous,
          relays: publishRelays,
          inheritPendingTargets: false,
          onSigned: (event) => {
            if (activeBaseKeyRef.current !== baseKey) return;
            ownEventRef.current = event;
          },
        });
        if (completeMigration) completeLegacyFavoriteGifMigration();
      } catch (error) {
        if (isPublishQueuedError(error)) {
          if (completeMigration) completeLegacyFavoriteGifMigration();
        } else {
          dirtyBeforePull.current = true;
          console.warn("Failed to sync GIF favorites:", error);
        }
      } finally {
        void queryClient.invalidateQueries({ queryKey: [QUERY_KEY, pubkey] });
      }
    };

    publishChain.current = publishChain.current.then(run, run);
    return publishChain.current;
  }, [automaticSettingsSync, publishEvent, queryClient, syncBaseKey, user]);

  useEffect(() => {
    const accountChanged = previousPubkey.current !== user?.pubkey;
    const baseChanged = previousBaseKey.current !== syncBaseKey;
    if (accountChanged) dirtyBeforePull.current = false;
    else if (baseChanged && user?.pubkey) dirtyBeforePull.current = true;
    previousPubkey.current = user?.pubkey;
    previousBaseKey.current = syncBaseKey;
    pulledForBaseKey.current = undefined;
    publishRelaysRef.current = [];
    blockedOwnRef.current = false;
    ownEventRef.current = undefined;
    lastCreatedAtRef.current = 0;
    migrationInFlight.current = false;
  }, [syncBaseKey, user?.pubkey]);

  // Changes made while opted out remain in this installation's local shard.
  // Enabling synchronization is an explicit request to publish that current
  // shard after the remote shards have been pulled and merged.
  useEffect(() => {
    const wasAutomatic = previousAutomatic.current;
    previousAutomatic.current = automaticSettingsSync;
    if (wasAutomatic || !automaticSettingsSync) return;
    pulledForBaseKey.current = undefined;
    dirtyBeforePull.current = true;
    void queryClient.invalidateQueries({ queryKey: [QUERY_KEY, user?.pubkey] });
  }, [automaticSettingsSync, queryClient, user?.pubkey]);

  // Apply every remote device shard, then safely claim this installation's
  // pre-sync list. The legacy key is removed only once the encrypted shard has
  // been signed and durably queued by useNostrPublish.
  useEffect(() => {
    const pubkey = user?.pubkey;
    const baseKey = syncBaseKey;
    if (
      !automaticSettingsSync
      || !pubkey
      || !baseKey
      || !query.data
      || query.data.baseKey !== baseKey
    ) return;
    hydrateFavoriteGifShards(pubkey, query.data.shards);
    const ownD = getFavoriteGifShardDTag(pubkey);
    blockedOwnRef.current = query.data.unreadable.has(ownD);
    const ownEvent = query.data.ownEvents.get(ownD);
    if (ownEvent && eventWins(ownEvent, ownEventRef.current)) {
      ownEventRef.current = ownEvent;
      lastCreatedAtRef.current = Math.max(lastCreatedAtRef.current, ownEvent.created_at);
    }
    publishRelaysRef.current = query.data.publishRelays;
    pulledForBaseKey.current = baseKey;

    const migration = claimLegacyFavoriteGifs(pubkey);
    const ownShard = loadOwnFavoriteGifShard(pubkey);
    const remoteHasExactOwn = query.data.shards.some((shard) =>
      shard.deviceId === ownShard.deviceId
      && JSON.stringify(shard.records) === JSON.stringify(ownShard.records));
    const pendingDirty = dirtyBeforePull.current
      || (ownShard.records.length > 0 && !remoteHasExactOwn);
    dirtyBeforePull.current = false;
    if (!migration.hadLegacy && !pendingDirty) return;
    if (migration.hadLegacy && ownShard.records.length === 0) {
      completeLegacyFavoriteGifMigration();
      return;
    }
    if (blockedOwnRef.current) {
      dirtyBeforePull.current = true;
      return;
    }
    if (migrationInFlight.current) return;
    migrationInFlight.current = true;
    void publishCurrentShard(migration.hadLegacy).finally(() => {
      migrationInFlight.current = false;
    });
  }, [automaticSettingsSync, publishCurrentShard, query.data, syncBaseKey, user?.pubkey]);

  // Explicit favorite/unfavorite actions update local state immediately, then
  // coalesce rapid clicks into one rewrite of this installation's shard.
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!automaticSettingsSync || !pubkey || !user.signer.nip44) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeFavoriteGifChanges((changedPubkey) => {
      if (changedPubkey !== pubkey) return;
      if (!syncBaseKey || pulledForBaseKey.current !== syncBaseKey) {
        dirtyBeforePull.current = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void publishCurrentShard(false), FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [automaticSettingsSync, publishCurrentShard, syncBaseKey, user]);
}

export const favoriteGifsSyncQueryKey = [QUERY_KEY] as const;

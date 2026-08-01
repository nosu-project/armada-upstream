import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  claimLegacyFavoriteGifs,
  completeLegacyFavoriteGifMigration,
  FAVORITE_GIFS_D_PREFIX,
  FAVORITE_GIFS_EVENT_KIND,
  FAVORITE_GIFS_EVENT_TAG,
  getFavoriteGifShardDTag,
  hydrateFavoriteGifShards,
  loadOwnFavoriteGifShard,
  parseFavoriteGifShard,
  subscribeFavoriteGifChanges,
  type FavoriteGifShard,
} from "@/hooks/useFavoriteGifs";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { isPublishQueuedError } from "@/lib/publishOutbox";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

const QUERY_KEY = "favorite-gifs-sync";
const PUBLISH_DEBOUNCE_MS = 400;

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

async function decodeShards(
  pubkey: string,
  decrypt: (pubkey: string, content: string) => Promise<string>,
  events: NostrRumor[],
): Promise<{ shards: FavoriteGifShard[]; ownEvents: Map<string, NostrRumor> }> {
  const newest = new Map<string, NostrRumor>();
  for (const event of events) {
    const identifier = dTag(event);
    if (!identifier?.startsWith(FAVORITE_GIFS_D_PREFIX)) continue;
    const current = newest.get(identifier);
    if (eventWins(event, current)) newest.set(identifier, event);
  }

  const decoded = await Promise.all([...newest.entries()].map(async ([identifier, event]) => {
    try {
      const plaintext = await decrypt(pubkey, event.content);
      const shard = parseFavoriteGifShard(JSON.parse(plaintext));
      if (!shard || identifier !== `${FAVORITE_GIFS_D_PREFIX}${shard.deviceId}`) return null;
      return { identifier, event, shard };
    } catch {
      return null;
    }
  }));

  const shards: FavoriteGifShard[] = [];
  const ownEvents = new Map<string, NostrRumor>();
  for (const item of decoded) {
    if (!item) continue;
    shards.push(item.shard);
    ownEvents.set(item.identifier, item.event);
  }
  return { shards, ownEvents };
}

/**
 * Always-on encrypted sync for GIF favorites. Each installation owns one
 * addressable shard; merging all shards gives add/remove convergence without
 * one upgrading device being able to replace another device's old favorites.
 */
export function useFavoriteGifsSync(): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const ownEventRef = useRef<NostrRumor | undefined>(undefined);
  const lastCreatedAtRef = useRef(0);
  const migrationInFlight = useRef(false);
  const publishChain = useRef<Promise<void>>(Promise.resolve());
  const pulledForPubkey = useRef<string | undefined>(undefined);
  const dirtyBeforePull = useRef(false);

  const queryKey = [QUERY_KEY, user?.pubkey];
  const query = useQuery({
    queryKey,
    enabled: !!user?.pubkey && !!user.signer.nip44,
    queryFn: async ({ signal }) => {
      if (!user?.signer.nip44) return { shards: [], ownEvents: new Map<string, NostrRumor>() };
      const filter = favoriteGifFilter(user.pubkey);
      const [remote, store] = await Promise.all([
        nostr.query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) }),
        eventStore,
      ]);
      const cached = await store.query([filter]);
      const byId = new Map<string, NostrRumor>();
      for (const event of [...cached, ...remote]) byId.set(event.id, event);
      return decodeShards(
        user.pubkey,
        (pubkey, content) => user.signer.nip44!.decrypt(pubkey, content),
        [...byId.values()],
      );
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });

  const publishCurrentShard = useCallback((completeMigration: boolean) => {
    const pubkey = user?.pubkey;
    const nip44 = user?.signer.nip44;
    if (!pubkey || !nip44) return Promise.resolve();

    const run = async () => {
      const shard = loadOwnFavoriteGifShard(pubkey);
      if (shard.records.length === 0) {
        if (completeMigration) completeLegacyFavoriteGifMigration();
        return;
      }
      const content = await nip44.encrypt(pubkey, JSON.stringify(shard));
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
          onSigned: (event) => {
            ownEventRef.current = event;
            if (completeMigration) completeLegacyFavoriteGifMigration();
          },
        });
      } catch (error) {
        if (!isPublishQueuedError(error)) console.warn("Failed to sync GIF favorites:", error);
      } finally {
        void queryClient.invalidateQueries({ queryKey: [QUERY_KEY, pubkey] });
      }
    };

    publishChain.current = publishChain.current.then(run, run);
    return publishChain.current;
  }, [publishEvent, queryClient, user]);

  useEffect(() => {
    pulledForPubkey.current = undefined;
    dirtyBeforePull.current = false;
    ownEventRef.current = undefined;
    lastCreatedAtRef.current = 0;
    migrationInFlight.current = false;
  }, [user?.pubkey]);

  // Apply every remote device shard, then safely claim this installation's
  // pre-sync list. The legacy key is removed only once the encrypted shard has
  // been signed and durably queued by useNostrPublish.
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!pubkey || !query.data) return;
    hydrateFavoriteGifShards(pubkey, query.data.shards);
    const ownD = getFavoriteGifShardDTag(pubkey);
    const ownEvent = query.data.ownEvents.get(ownD);
    if (ownEvent && eventWins(ownEvent, ownEventRef.current)) {
      ownEventRef.current = ownEvent;
      lastCreatedAtRef.current = Math.max(lastCreatedAtRef.current, ownEvent.created_at);
    }
    pulledForPubkey.current = pubkey;

    const migration = claimLegacyFavoriteGifs(pubkey);
    const pendingDirty = dirtyBeforePull.current;
    dirtyBeforePull.current = false;
    if (!migration.hadLegacy && !pendingDirty) return;
    if (migration.hadLegacy && loadOwnFavoriteGifShard(pubkey).records.length === 0) {
      completeLegacyFavoriteGifMigration();
      return;
    }
    if (migrationInFlight.current) return;
    migrationInFlight.current = true;
    void publishCurrentShard(migration.hadLegacy).finally(() => {
      migrationInFlight.current = false;
    });
  }, [publishCurrentShard, query.data, user?.pubkey]);

  // Explicit favorite/unfavorite actions update local state immediately, then
  // coalesce rapid clicks into one rewrite of this installation's shard.
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!pubkey || !user.signer.nip44) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeFavoriteGifChanges((changedPubkey) => {
      if (changedPubkey !== pubkey) return;
      if (pulledForPubkey.current !== pubkey) {
        dirtyBeforePull.current = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void publishCurrentShard(false), PUBLISH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [publishCurrentShard, user]);
}

export const favoriteGifsSyncQueryKey = [QUERY_KEY] as const;

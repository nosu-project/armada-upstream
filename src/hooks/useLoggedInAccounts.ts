import { useNostr } from '@nostrify/react';
import { useNostrLogin } from '@nostrify/react/login';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { NostrMetadata } from '@nostrify/nostrify';

import { useEventStore } from '@/hooks/useEventStore';
import { metadataSchema } from '@/lib/authorCache';
import type { NostrRumor } from "@/lib/nostrRumor";
import { parseProfileImeta, type ProfileImeta } from '@/lib/profileImeta';

export interface Account {
  id: string;
  pubkey: string;
  event?: NostrRumor;
  metadata: NostrMetadata;
  /** Describes `picture`/`banner`. */
  imeta?: ProfileImeta;
}

function parseMetadata(event: NostrRumor | undefined): NostrMetadata {
  try {
    return metadataSchema.parse(event?.content);
  } catch {
    return {};
  }
}

/** An account's metadata and the imeta describing its images. */
function parseProfile(event: NostrRumor | undefined): { metadata: NostrMetadata; imeta?: ProfileImeta } {
  const metadata = parseMetadata(event);
  const imeta = event && parseProfileImeta(event.tags, metadata);
  return imeta ? { metadata, imeta } : { metadata };
}

interface LoginRef {
  id: string;
  pubkey: string;
}

/**
 * Freshest kind-0 per login with the cache as a floor: relay event, else previous result,
 * else local store, else empty — so the switcher never blanks on a slow read. `cachedFor` is only
 * called for logins the relay missed.
 */
export async function mergeAccounts(
  logins: readonly LoginRef[],
  freshEvents: NostrRumor[],
  prev: Account[],
  cachedFor: (pubkey: string) => Promise<NostrRumor | undefined>,
): Promise<Account[]> {
  return Promise.all(    logins.map(async ({ id, pubkey }): Promise<Account> => {
      const fresh = freshEvents.find((e) => e.pubkey === pubkey);
      if (fresh) return { id, pubkey, ...parseProfile(fresh), event: fresh };

      const existing = prev.find((a) => a.id === id);
      if (existing?.event) return existing;

      const cached = await cachedFor(pubkey);
      if (cached) return { id, pubkey, ...parseProfile(cached), event: cached };

      return { id, pubkey, metadata: {} };
    }),
  );
}

export function useLoggedInAccounts() {
  const { nostr } = useNostr();
  const { logins, setLogin, removeLogin } = useNostrLogin();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = ['nostr', 'logins', logins.map((l) => l.id).join(';')];

  // Cache-first seed from the local event store so the switcher renders names/avatars instantly,
  // including offline.
  useEffect(() => {
    if (logins.length === 0) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;
      const store = await eventStore;
      const events = await store.query([
        { kinds: [0], authors: logins.map((l) => l.pubkey) },
      ]);
      if (cancelled || events.length === 0) return;
      if (queryClient.getQueryData(queryKey)) return;
      queryClient.setQueryData<Account[]>(
        queryKey,
        logins.map(({ id, pubkey }) => {
          const event = events.find((e) => e.pubkey === pubkey);
          return { id, pubkey, ...parseProfile(event), event };
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logins.map((l) => l.id).join(';'), eventStore, queryClient]);

  const { data: authors = [], isLoading } = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const store = await eventStore;
      const events = await nostr.query(
        [{ kinds: [0], authors: logins.map((l) => l.pubkey) }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );

      for (const event of events) void store.event(event);

      // Never blank an account we already have just because this read was slow/empty.
      const prev = queryClient.getQueryData<Account[]>(queryKey) ?? [];
      return mergeAccounts(logins, events, prev, async (pubkey) => {
        const [cached] = await store.query([{ kinds: [0], authors: [pubkey] }]);
        return cached;
      });
    },
    enabled: logins.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 3,
  });

  const currentUser: Account | undefined = (() => {
    const login = logins[0];
    if (!login) return undefined;
    const author = authors.find((a) => a.id === login.id);
    return { metadata: {}, ...author, id: login.id, pubkey: login.pubkey };
  })();

  const otherUsers = (authors || []).slice(1) as Account[];

  return {
    authors,
    currentUser,
    otherUsers,
    isLoading,
    setLogin,
    removeLogin,
  };
}
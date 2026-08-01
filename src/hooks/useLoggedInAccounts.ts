import { useNostr } from '@nostrify/react';
import { useNostrLogin } from '@nostrify/react/login';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { NSchema as n, NostrMetadata } from '@nostrify/nostrify';

import { useEventStore } from '@/hooks/useEventStore';
import type { NostrRumor } from "@/lib/nostrRumor";

export interface Account {
  id: string;
  pubkey: string;
  event?: NostrRumor;
  metadata: NostrMetadata;
}

/** Parse a kind-0 event's content into metadata (empty object on failure). */
function parseMetadata(event: NostrRumor | undefined): NostrMetadata {
  try {
    return n.json().pipe(n.metadata()).parse(event?.content);
  } catch {
    return {};
  }
}

/** A login identity to resolve a kind-0 profile for. */
interface LoginRef {
  id: string;
  pubkey: string;
}

/**
 * Resolve each login to an {@link Account}, using the freshest available kind-0
 * with the cache as a floor: prefer the relay's fresh event, else the previous
 * result, else the locally cached event, else empty metadata. This is what
 * keeps the account switcher from blanking a name/avatar on a slow/offline read
 * (the bug: it only ever used a single tight-timeout relay query).
 *
 * `cachedFor(pubkey)` returns the locally-stored kind-0 for a pubkey (or
 * undefined); it's a callback so the store read only happens for the logins the
 * relay actually missed.
 */
export async function mergeAccounts(
  logins: readonly LoginRef[],
  freshEvents: NostrRumor[],
  prev: Account[],
  cachedFor: (pubkey: string) => Promise<NostrRumor | undefined>,
): Promise<Account[]> {
  return Promise.all(    logins.map(async ({ id, pubkey }): Promise<Account> => {
      const fresh = freshEvents.find((e) => e.pubkey === pubkey);
      if (fresh) return { id, pubkey, metadata: parseMetadata(fresh), event: fresh };

      const existing = prev.find((a) => a.id === id);
      if (existing?.event) return existing;

      const cached = await cachedFor(pubkey);
      if (cached) return { id, pubkey, metadata: parseMetadata(cached), event: cached };

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

  // Cache-first seed: hydrate each account's kind-0 from the local event store
  // (where NostrBatcher mirrors every profile that flows through) so the account
  // switcher renders names/avatars instantly on reload — including offline —
  // instead of collapsing to bare pubkeys while the relay round-trips. Without
  // this the switcher was the ONE profile surface that ignored offline storage.
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
          return { id, pubkey, metadata: parseMetadata(event), event };
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

      // Persist whatever the relays returned so the cache stays warm.
      for (const event of events) void store.event(event);

      // Merge with the cache as a floor: never blank an account we already have
      // a name/avatar for just because this relay read was slow/empty/offline.
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

  // Current user is the first login
  const currentUser: Account | undefined = (() => {
    const login = logins[0];
    if (!login) return undefined;
    const author = authors.find((a) => a.id === login.id);
    return { metadata: {}, ...author, id: login.id, pubkey: login.pubkey };
  })();

  // Other users are all logins except the current one
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
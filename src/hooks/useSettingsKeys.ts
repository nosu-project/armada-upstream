import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { copyLegacySettingsDocs } from "@/hooks/useSettingsDoc";
import {
  ensureSettingsKeys,
  resolveSettingsKeys,
  type SettingsKeys,
} from "@/lib/settingsRootStore";

export const SETTINGS_ROOT_QUERY_KEY = "settings-root";

export function settingsKeysQueryKey(pubkey: string | undefined) {
  return [SETTINGS_ROOT_QUERY_KEY, pubkey];
}

const NO_KEYS: SettingsKeys = { keyring: null, previous: [] };

/** The documents whose reads depend on which root is held. */
const ROOT_DEPENDENT_KEYS = [["settings-doc"], ["favorite-gifs-sync"], ["dm-conversations-sync"]];

/** Last keyring each account's readers were invalidated for; one invalidation per change. */
const announced = new Map<string, string | null>();

function announce(queryClient: QueryClient, pubkey: string, keys: SettingsKeys): void {
  const id = keys.keyring?.id ?? null;
  if (!announced.has(pubkey)) {
    announced.set(pubkey, id);
    return;
  }
  if (announced.get(pubkey) === id) return;
  announced.set(pubkey, id);
  for (const queryKey of ROOT_DEPENDENT_KEYS) void queryClient.invalidateQueries({ queryKey });
}

export interface UseSettingsKeysReturn {
  keys: SettingsKeys;
  isFetched: boolean;
  /**
   * The keys, creating the root when the account has none. Not `explicit`, a
   * root is created only for an account that already keeps Armada settings.
   */
  ensure: (explicit?: boolean) => Promise<SettingsKeys>;
}

/** The settings root this device holds, as derived document keys. */
export function useSettingsKeys(): UseSettingsKeysReturn {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const pubkey = user?.pubkey;

  const query = useQuery<SettingsKeys>({
    queryKey: settingsKeysQueryKey(pubkey),
    enabled: !!pubkey,
    queryFn: async () => {
      if (!user) return NO_KEYS;
      return resolveSettingsKeys(await eventStore, user.signer, user.pubkey);
    },
    staleTime: Infinity,
  });

  const keys = query.data ?? NO_KEYS;
  useEffect(() => {
    if (pubkey && query.data) announce(queryClient, pubkey, query.data);
  }, [pubkey, query.data, queryClient]);

  const ensure = useCallback(async (explicit = false) => {
    if (!user) throw new Error("Not logged in");
    const store = await eventStore;
    const ensured = await ensureSettingsKeys({
      nostr,
      store,
      signer: user.signer,
      pubkey: user.pubkey,
      relays: selfStateRelays(config, user.pubkey),
      explicit,
      onCreated: (created) => copyLegacySettingsDocs({
        nostr,
        store,
        signer: user.signer,
        pubkey: user.pubkey,
        keys: created,
        relays: selfStateRelays(config, user.pubkey),
      }),
    });
    queryClient.setQueryData(settingsKeysQueryKey(user.pubkey), ensured);
    announce(queryClient, user.pubkey, ensured);
    return ensured;
  }, [config, eventStore, nostr, queryClient, user]);

  return { keys, isFetched: query.isFetched, ensure };
}

/** Test seam. */
export function resetSettingsKeysAnnouncements(): void {
  announced.clear();
}

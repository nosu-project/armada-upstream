import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import type { NostrFilter, NostrSigner } from "@nostrify/nostrify";

import { accountDataRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { APP_NAME } from "@/lib/platform";
import { EncryptedSettingsSchema, type EncryptedSettings } from "@/lib/schemas";
import { queryExplicitRelays } from "@/lib/nip65";
import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-78 application-data kind. */
const SETTINGS_KIND = 30078;
/** `d` tag identifying Armada's settings event. */
const SETTINGS_D = "armada/metadata";

/** Filter matching the current user's settings event. */
function settingsFilter(pubkey: string): NostrFilter {
  return { kinds: [SETTINGS_KIND], authors: [pubkey], "#d": [SETTINGS_D], limit: 1 };
}

/** Decrypt + validate a settings event into EncryptedSettings, or null. */
async function decodeSettings(
  signer: NostrSigner,
  pubkey: string,
  event: NostrRumor | undefined,
): Promise<EncryptedSettings | null> {
  if (!event?.content || !signer.nip44) return null;
  try {
    const decrypted = await signer.nip44.decrypt(pubkey, event.content);
    const parsed = EncryptedSettingsSchema.safeParse(JSON.parse(decrypted));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    console.warn("Failed to decrypt settings:", err);
    return null;
  }
}

/**
 * ms timestamp of the last local encrypted-settings write this session. Lets
 * NostrSync avoid overwriting a fresh local edit with a stale relay event.
 */
let lastWriteTs = 0;
export function getLastSettingsWrite(): number {
  return lastWriteTs;
}
/**
 * Mark "now" as a local edit time. Called the moment a synced-config edit is
 * detected — BEFORE the debounced publish actually runs — so NostrSync's
 * `remoteTs > localTs` guard protects the fresh edit during the debounce window
 * (otherwise a stale relay copy landing in that window can revert it).
 */
export function setLastSettingsWrite(ts: number = Date.now()): void {
  lastWriteTs = ts;
}

/** Persist the synced timestamp per-pubkey so reloads can trust localStorage. */
export function getLocalSettingsSync(pubkey: string): number {
  try {
    return Number(localStorage.getItem(`armada:settings-lastSync:${pubkey}`)) || 0;
  } catch {
    return 0;
  }
}
export function setLocalSettingsSync(pubkey: string, lastSync: number): void {
  try {
    localStorage.setItem(`armada:settings-lastSync:${pubkey}`, String(lastSync));
  } catch {
    // localStorage unavailable — ignore.
  }
}

/**
 * Read and write the user's encrypted app settings (theme + customTheme +
 * themes) as a NIP-44-encrypted kind 30078 event on the app relays. Adapted
 * from Ditto's useEncryptedSettings.
 */
export function useEncryptedSettings() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const pendingSettings = useRef<EncryptedSettings | null>(null);

  const queryKey = ["encrypted-settings", user?.pubkey];

  const settings = useQuery<EncryptedSettings | null>({
    queryKey,
    enabled: !!user?.pubkey && !!user.signer.nip44,
    queryFn: async ({ signal }) => {
      if (!user?.signer.nip44) return null;

      const events = await queryExplicitRelays(
        nostr,
        accountDataRelays(config, user.pubkey),
        [settingsFilter(user.pubkey)],
        AbortSignal.any([signal, AbortSignal.timeout(6000)]),
      );

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];

      // No event from the relay (offline, slow, EOSE before it arrived, or a
      // genuine first load): fall back to the locally cached copy in
      // NIndexedDB so the last-known config still applies. IMPORTANT: because
      // `nostr.query` swallows relay errors/timeouts and returns whatever it
      // collected before EOSE, a `null` result here does NOT prove the user
      // has no settings — it may just mean we failed to read them. NostrSync
      // treats this ambiguity conservatively and never opens its outgoing-
      // publish gate off a null pull (it requires a positively observed remote
      // settings event first).
      if (!event) {
        const store = await eventStore;
        const cached = await store.query([settingsFilter(user.pubkey)]);
        const newest = cached.sort((a, b) => b.created_at - a.created_at)[0];
        return decodeSettings(user.signer, user.pubkey, newest);
      }

      // Mirror the fresh event into the local store (fire-and-forget) so it is
      // available offline on the next load.
      void eventStore.then((store) => store.event(event)).catch(() => undefined);
      return decodeSettings(user.signer, user.pubkey, event);
    },
    staleTime: 60_000,
    // Cross-device freshness is driven by NostrSync's standing self-state REQ,
    // which invalidates this query when another device publishes new settings.
    // Keep focus/mount refetch as a cheap backstop (catches anything the sub
    // missed while the socket was down), but no periodic poll — the sub is the
    // push channel now.
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });

  const updateSettings = useMutation({
    mutationFn: async (patch: Partial<EncryptedSettings>) => {
      if (!user?.signer.nip44) throw new Error("NIP-44 encryption not supported by signer");

      // Merge over the freshest known state (cache + this session's pending).
      const base: EncryptedSettings = {
        ...(settings.data ?? {}),
        ...(pendingSettings.current ?? {}),
      };
      const next: EncryptedSettings = { ...base, ...patch, lastSync: Date.now() };
      pendingSettings.current = next;
      lastWriteTs = Date.now();

      const plaintext = JSON.stringify(next);
      const content = await user.signer.nip44.encrypt(user.pubkey, plaintext);

      const event = await user.signer.signEvent({
        kind: SETTINGS_KIND,
        content,
        tags: [
          ["d", SETTINGS_D],
          ["title", `${APP_NAME} Settings`],
        ],
        created_at: Math.floor(Date.now() / 1000),
      });

      // Optimistically update the cache, then publish in the background.
      queryClient.setQueryData(queryKey, next);
      setLocalSettingsSync(user.pubkey, next.lastSync ?? Date.now());
      // Persist locally first (offline durability), then publish.
      void eventStore.then((store) => store.event(event)).catch(() => undefined);
      nostr.event(event, { signal: AbortSignal.timeout(8000) }).catch((err) => {
        console.warn("Failed to publish encrypted settings:", err);
      });

      return next;
    },
  });

  return {
    settings: settings.data ?? null,
    isLoading: settings.isLoading,
    /** True once the query has resolved at least once (event or cache miss). */
    isFetched: settings.isFetched,
    /**
     * True once the settings query has completed a successful pull (the query
     * never rejects — NPool swallows relay errors — so in practice this tracks
     * "the first fetch has resolved"). NostrSync waits for this before acting,
     * but does NOT treat it as proof the remote was read; see its publish gate.
     */
    isSuccess: settings.isSuccess,
    refetch: settings.refetch,
    updateSettings: updateSettings.mutateAsync,
    hasNip44Support: !!user?.signer.nip44,
  };
}

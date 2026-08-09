import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { NostrFilter, NostrSigner } from "@nostrify/nostrify";

import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import type { NostrRumor } from "@/lib/nostrRumor";
import { APP_NAME } from "@/lib/platform";
import { EncryptedSettingsSchema, type EncryptedSettings } from "@/lib/schemas";
import { D_ARMADA_METADATA, KIND_APP_SPECIFIC } from "@/lib/selfSyncKinds";

/**
 * The user's private app settings: one NIP-44-encrypted, NIP-78 addressable
 * document (kind 30078, `d=armada/metadata`) holding the portable slice of
 * AppConfig, read-state and the quick-reaction table.
 *
 * ARMADADB IS THE MODEL. This hook never reads a relay. The document reaches
 * disk from three places, and all three are live rather than polled:
 *
 *   • NostrSync's standing self-state REQ, which carries no `since` and so
 *     redelivers the current version on every (re)subscribe;
 *   • on Android, the notification service's identical standing REQ, which
 *     writes to the SAME database file while this process is dead;
 *   • useInitialSync's cold-boot read, and an explicit portable-setup publish.
 *
 * The store settles versions by NIP-01 addressable supersession — strictly
 * newer `created_at` replaces, ties keep what is stored — so "the document on
 * disk" is by construction the newest one this device has ever seen, from any
 * source. That is what a write merges over, and it is why none of the sync
 * arbitration this hook used to carry (a source discriminator, a completeness
 * flag, a localStorage watermark, a module-global write clock) exists any more:
 * they were all standing in for an ordering the store already enforces.
 *
 * The one rule callers must keep: {@link useEncryptedSettings.updateSettings}
 * merges its patch over `{}` when the store holds no document. Because this is
 * a replaceable event, publishing that would REPLACE the user's real settings
 * with whatever subset the caller passed, on every device. So a caller that
 * publishes on its own schedule must first check that `settings` is non-null.
 */
export const SETTINGS_KIND = KIND_APP_SPECIFIC;
export const SETTINGS_D = D_ARMADA_METADATA;

/** Filter matching a user's settings document. */
export function settingsFilter(pubkey: string): NostrFilter {
  return { kinds: [SETTINGS_KIND], authors: [pubkey], "#d": [SETTINGS_D], limit: 1 };
}

/** A settings document as stored: the event it came in, and its plaintext. */
export interface StoredSettings {
  event: NostrRumor;
  settings: EncryptedSettings;
}

/**
 * The newest settings document in ArmadaDB, decrypted, or null when there is
 * none (or it can't be decrypted — a signer that changed, a corrupt payload).
 *
 * Exported because the write path needs exactly this read, and so does the
 * explicit portable-setup publish.
 */
export async function readStoredSettings(
  store: ArmadaEventStore,
  signer: NostrSigner,
  pubkey: string,
): Promise<StoredSettings | null> {
  if (!signer.nip44) return null;

  let event: NostrRumor | undefined;
  try {
    for (const rumor of await store.query([settingsFilter(pubkey)])) {
      if (!event || rumor.created_at > event.created_at) event = rumor;
    }
  } catch {
    return null; // Store unavailable; treat as "nothing on disk".
  }
  if (!event?.content) return null;

  try {
    const plaintext = await signer.nip44.decrypt(pubkey, event.content);
    const parsed = EncryptedSettingsSchema.safeParse(JSON.parse(plaintext));
    return parsed.success ? { event, settings: parsed.data } : null;
  } catch (err) {
    console.warn("Failed to decrypt settings:", err);
    return null;
  }
}

/** Read and write the current user's encrypted app settings. */
export function useEncryptedSettings() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = ["encrypted-settings", user?.pubkey];

  const settings = useQuery<StoredSettings | null>({
    queryKey,
    enabled: !!user?.pubkey && !!user.signer.nip44,
    queryFn: async () => {
      if (!user) return null;
      return readStoredSettings(await eventStore, user.signer, user.pubkey);
    },
  });

  const updateSettings = useMutation({
    mutationFn: async (patch: Partial<EncryptedSettings>) => {
      if (!user?.signer.nip44) throw new Error("NIP-44 encryption not supported by signer");
      const store = await eventStore;

      // Read, then write — from the store, not from this query's cache. The
      // cache is a snapshot taken whenever the query last ran; the store is
      // written the moment a new version arrives on the wire, and on Android
      // it is written by the notification service with no JS running at all.
      // Merging a patch over the cache and stamping it newest is how another
      // device's change gets reverted.
      const previous = await readStoredSettings(store, user.signer, user.pubkey);
      const next: EncryptedSettings = {
        ...(previous?.settings ?? {}),
        ...patch,
        // Kept for older Armada builds on the user's other devices, which order
        // versions by this rather than by `created_at`.
        lastSync: Date.now(),
      };

      const event = await user.signer.signEvent({
        kind: SETTINGS_KIND,
        content: await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(next)),
        tags: [
          ["d", SETTINGS_D],
          ["title", `${APP_NAME} Settings`],
        ],
        // Strictly newer than what we merged over, so this version wins the
        // coordinate rather than being discarded — including by our own store,
        // which refuses a write that isn't newer than what it holds. Two edits
        // inside one second would otherwise leave the second one nowhere.
        created_at: Math.max(Math.floor(Date.now() / 1000), (previous?.event.created_at ?? 0) + 1),
      });

      // Durable first, then visible, then published. An edit survives a kill
      // between the signature and the relay round-trip.
      await store.event(event);
      queryClient.setQueryData<StoredSettings>(queryKey, { event, settings: next });
      nostr.event(event, { signal: AbortSignal.timeout(8000) }).catch((err) => {
        console.warn("Failed to publish encrypted settings:", err);
      });

      return next;
    },
  });

  return {
    /** The decrypted settings document, or null when none is on disk. */
    settings: settings.data?.settings ?? null,
    /** The event it was decrypted from — identity, for "have I applied this?". */
    settingsEvent: settings.data?.event ?? null,
    isLoading: settings.isLoading,
    /** True once the store has been read at least once. */
    isFetched: settings.isFetched,
    updateSettings: updateSettings.mutateAsync,
    hasNip44Support: !!user?.signer.nip44,
  };
}

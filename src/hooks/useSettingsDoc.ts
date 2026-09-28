import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { NostrFilter, NostrSigner } from "@nostrify/nostrify";
import type { z } from "zod";

import { selfStateRelays } from "@/contexts/AppContext";
import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { publishSignedEventToRelays } from "@/lib/nip65";
import {
  PublishQueuedError,
  queueSignedEvent,
  recordQueuedPublishAttempt,
} from "@/lib/publishOutbox";
import type { NostrRumor } from "@/lib/nostrRumor";
import { APP_NAME } from "@/lib/platform";
import {
  SETTINGS_DOC_SCHEMAS,
  SETTINGS_KIND,
  parseSettingsDoc,
  settingsDTag,
  stripMigratedKeys,
  type SettingsDocName,
} from "@/lib/settingsDocs";

import type { MetadataDoc } from "@/lib/schemas";

/**
 * Read/write one encrypted NIP-78 settings document (kind 30078, `d = ${APP_ID}/<name>`); see
 * `lib/settingsDocs.ts` and `docs/settings-documents.md`.
 * ARMADADB IS THE MODEL: this hook never reads a relay. Documents arrive via NostrSync's standing
 * REQ, the Android service's identical REQ, and useInitialSync / portable-setup publish; the store
 * keeps the newest by NIP-01 supersession.
 * Callers must check `doc` is non-null before publishing on their own schedule: `update` merges over
 * `{}` when nothing is stored, which would REPLACE the user's real document everywhere.
 */

type DocSchemas = typeof SETTINGS_DOC_SCHEMAS;

export type SettingsDocOf<N extends SettingsDocName> = z.infer<DocSchemas[N]>;

export interface StoredSettingsDoc<N extends SettingsDocName> {
  event: NostrRumor;
  doc: SettingsDocOf<N>;
}

export function settingsDocFilter(pubkey: string, name: SettingsDocName): NostrFilter {
  return {
    kinds: [SETTINGS_KIND],
    authors: [pubkey],
    "#d": [settingsDTag(name)],
    limit: 1,
  };
}

export function settingsDocQueryKey(name: SettingsDocName, pubkey: string | undefined) {
  return ["settings-doc", name, pubkey];
}

/** Newest stored version, decrypted; null if none or undecryptable. */
export async function readSettingsDoc<N extends SettingsDocName>(
  store: ArmadaEventStore,
  signer: NostrSigner,
  pubkey: string,
  name: N,
): Promise<StoredSettingsDoc<N> | null> {
  if (!signer.nip44) return null;

  let event: NostrRumor | undefined;
  try {
    for (const rumor of await store.query([settingsDocFilter(pubkey, name)])) {
      if (!event || rumor.created_at > event.created_at) event = rumor;
    }
  } catch {
    return null; // Store unavailable; treat as "nothing on disk".
  }
  if (!event?.content) return null;

  return decodeSettingsDoc(event, signer, pubkey, name);
}

export async function decodeSettingsDoc<N extends SettingsDocName>(
  event: NostrRumor,
  signer: NostrSigner,
  pubkey: string,
  name: N,
): Promise<StoredSettingsDoc<N> | null> {
  if (!signer.nip44) return null;
  try {
    const plaintext = await signer.nip44.decrypt(pubkey, event.content);
    const parsed = parseSettingsDoc(name, JSON.parse(plaintext));
    if (parsed && parsed.dropped.length > 0) {
      console.warn(`Ignoring invalid ${name} settings field(s): ${parsed.dropped.join(", ")}`);
    }
    return parsed ? { event, doc: parsed.doc as SettingsDocOf<N> } : null;
  } catch (err) {
    console.warn(`Failed to decrypt ${name} settings:`, err);
    return null;
  }
}

/** Previous doc + patch, applying the `metadata`-specific rules. */
export function nextSettingsDoc<N extends SettingsDocName>(
  name: N,
  previous: SettingsDocOf<N> | undefined,
  patch: Partial<SettingsDocOf<N>>,
): SettingsDocOf<N> {
  const merged = { ...(previous ?? {}), ...patch } as SettingsDocOf<N>;
  if (name !== "metadata") return merged;
  return {
    // Fields that moved into their own documents are dropped — see `stripMigratedKeys`.
    ...stripMigratedKeys(merged as MetadataDoc),
    // For older builds that order versions by this rather than `created_at`. Metadata only.
    lastSync: Date.now(),
  } as SettingsDocOf<N>;
}

/**
 * Writes to one document run one at a time: concurrent read-modify-writes would read the same
 * version and collide on `created_at`. Distinct documents may write concurrently (cf.
 * `serializeGroupListWrite`).
 */
const settingsWriteChains = new Map<SettingsDocName, Promise<unknown>>();

function serializeSettingsWrite<T>(name: SettingsDocName, write: () => Promise<T>): Promise<T> {
  const chain = settingsWriteChains.get(name) ?? Promise.resolve();
  const run = chain.then(write, write);
  // Swallow on the chain so one failure doesn't wedge the queue; the caller still gets it.
  settingsWriteChains.set(name, run.then(() => undefined, () => undefined));
  return run;
}

export interface UseSettingsDocReturn<N extends SettingsDocName> {
  /** The decrypted document, or null when none is on disk. */
  doc: SettingsDocOf<N> | null;
  /** Identity, for "have I applied this?". */
  event: NostrRumor | null;
  isLoading: boolean;
  isFetched: boolean;
  update: (patch: Partial<SettingsDocOf<N>>) => Promise<SettingsDocOf<N>>;
  hasNip44Support: boolean;
}

export function useSettingsDoc<N extends SettingsDocName>(name: N): UseSettingsDocReturn<N> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = settingsDocQueryKey(name, user?.pubkey);

  const query = useQuery<StoredSettingsDoc<N> | null>({
    queryKey,
    enabled: !!user?.pubkey && !!user.signer.nip44,
    queryFn: async () => {
      if (!user) return null;
      return readSettingsDoc(await eventStore, user.signer, user.pubkey, name);
    },
  });

  const mutation = useMutation({
    mutationFn: (patch: Partial<SettingsDocOf<N>>) => serializeSettingsWrite(name, async () => {
      if (!user?.signer.nip44) throw new Error("NIP-44 encryption not supported by signer");
      const relays = selfStateRelays(config, user.pubkey);
      if (relays.length === 0) {
        throw new Error("Add an account write relay before synchronizing private settings");
      }
      const store = await eventStore;

      // Merge over the STORE, not the query cache: the store may hold a newer version (wire, Android
      // service), and merging over a stale cache reverts other devices' changes.
      const previous = await readSettingsDoc(store, user.signer, user.pubkey, name);
      const next = nextSettingsDoc(name, previous?.doc, patch);

      const event = await user.signer.signEvent({
        kind: SETTINGS_KIND,
        content: await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(next)),
        tags: [
          ["d", settingsDTag(name)],
          ["title", `${APP_NAME} Settings`],
        ],
        // Strictly newer than what we merged over, or the store (and relays) would discard it.
        created_at: Math.max(Math.floor(Date.now() / 1000), (previous?.event.created_at ?? 0) + 1),
      });

      // Durable first, then visible, then published; keep the exact destination set so a partial
      // fanout retries only missing account relays.
      let durablyQueued = false;
      try {
        await queueSignedEvent(event, undefined, relays);
        durablyQueued = true;
      } catch {
        // Only called queued once the signed obligation was read back.
      }
      await store.event(event);
      // Cancel in-flight refetches that could regress the cache to the previous version.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<StoredSettingsDoc<N>>(queryKey, { event, doc: next });
      const result = await publishSignedEventToRelays(nostr, event, relays, 8000);
      // Settle only this attempt's destinations; inherited old NIP-65 relays stay queued.
      await recordQueuedPublishAttempt(event.id, relays, result.rejected).catch(() => undefined);
      if (result.rejected.length > 0) {
        const cause = new Error(
          result.accepted.length > 0
            ? `${result.rejected.length} account relay delivery${result.rejected.length === 1 ? "" : "ies"} remain`
            : "No account relay accepted the settings update",
        );
        console.warn(`Failed to publish ${name} settings:`, cause);
        // Durable locally; surface the failure so auto sync (or "Sync now") retries the exact snapshot.
        if (durablyQueued) throw new PublishQueuedError(event, cause);
        throw cause;
      }
      return next;
    }),
  });

  const { mutateAsync } = mutation;
  const update = useCallback(
    (patch: Partial<SettingsDocOf<N>>) => mutateAsync(patch),
    [mutateAsync],
  );

  return {
    doc: query.data?.doc ?? null,
    event: query.data?.event ?? null,
    isLoading: query.isLoading,
    isFetched: query.isFetched,
    update,
    hasNip44Support: !!user?.signer.nip44,
  };
}

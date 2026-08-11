import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { NostrFilter, NostrSigner } from "@nostrify/nostrify";
import type { z } from "zod";

import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import type { NostrRumor } from "@/lib/nostrRumor";
import { APP_NAME } from "@/lib/platform";
import {
  SETTINGS_DOC_SCHEMAS,
  SETTINGS_KIND,
  settingsDTag,
  stripMigratedKeys,
  type SettingsDocName,
} from "@/lib/settingsDocs";

import type { MetadataDoc } from "@/lib/schemas";

/**
 * Read and write one of the user's encrypted NIP-78 settings documents (kind
 * 30078, `d = ${APP_ID}/<name>`). See `lib/settingsDocs.ts` for the catalogue
 * and `docs/settings-documents.md` for the design.
 *
 * ARMADADB IS THE MODEL. This hook never reads a relay. A document reaches
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
 * The one rule callers must keep: {@link UseSettingsDocReturn.update} merges
 * its patch over `{}` when the store holds no document. Because these are
 * replaceable events, publishing that would REPLACE the user's real document
 * with whatever subset the caller passed, on every device. So a caller that
 * publishes on its own schedule must first check that `doc` is non-null.
 */

type DocSchemas = typeof SETTINGS_DOC_SCHEMAS;

/** The plaintext type of the document named `N`. */
export type SettingsDocOf<N extends SettingsDocName> = z.infer<DocSchemas[N]>;

/** A settings document as stored: the event it came in, and its plaintext. */
export interface StoredSettingsDoc<N extends SettingsDocName> {
  event: NostrRumor;
  doc: SettingsDocOf<N>;
}

/** Filter matching one of a user's settings documents. */
export function settingsDocFilter(pubkey: string, name: SettingsDocName): NostrFilter {
  return {
    kinds: [SETTINGS_KIND],
    authors: [pubkey],
    "#d": [settingsDTag(name)],
    limit: 1,
  };
}

/** React-query key for a settings document. */
export function settingsDocQueryKey(name: SettingsDocName, pubkey: string | undefined) {
  return ["settings-doc", name, pubkey];
}

/**
 * The newest version of a settings document in ArmadaDB, decrypted, or null
 * when there is none (or it can't be decrypted — a signer that changed, a
 * corrupt payload).
 *
 * Exported because the write path needs exactly this read, and so do the
 * cold-boot sync and the explicit portable-setup publish.
 */
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

/** Decrypt and parse a settings event known to be the right document. */
export async function decodeSettingsDoc<N extends SettingsDocName>(
  event: NostrRumor,
  signer: NostrSigner,
  pubkey: string,
  name: N,
): Promise<StoredSettingsDoc<N> | null> {
  if (!signer.nip44) return null;
  try {
    const plaintext = await signer.nip44.decrypt(pubkey, event.content);
    const parsed = SETTINGS_DOC_SCHEMAS[name].safeParse(JSON.parse(plaintext));
    return parsed.success ? { event, doc: parsed.data as SettingsDocOf<N> } : null;
  } catch (err) {
    console.warn(`Failed to decrypt ${name} settings:`, err);
    return null;
  }
}

/**
 * Build the plaintext of the next version of a document from the previous one
 * plus a patch, applying the two rules that are specific to `metadata`.
 */
export function nextSettingsDoc<N extends SettingsDocName>(
  name: N,
  previous: SettingsDocOf<N> | undefined,
  patch: Partial<SettingsDocOf<N>>,
): SettingsDocOf<N> {
  const merged = { ...(previous ?? {}), ...patch } as SettingsDocOf<N>;
  if (name !== "metadata") return merged;
  return {
    // Fields that moved into their own documents are dropped rather than
    // carried forward — see `stripMigratedKeys`.
    ...stripMigratedKeys(merged as MetadataDoc),
    // Kept for older Armada builds on the user's other devices, which order
    // versions by this rather than by `created_at`. Metadata only: the split
    // documents postdate every build that reads it.
    lastSync: Date.now(),
  } as SettingsDocOf<N>;
}

/**
 * All writes to one settings document run one at a time, process-wide.
 *
 * A write is a read-modify-write spanning a store read, two signer round-trips
 * (decrypt + encrypt/sign) and a store write — seconds on a NIP-46 signer. Two
 * rail edits whose debounces fire back to back would otherwise both read the
 * SAME previous version, merge their patches independently, and stamp the same
 * `created_at` — so the second edit either overwrites the first or loses the
 * NIP-01 tie to it. Serializing per document makes each write observe the
 * previous one's result; distinct documents are distinct coordinates and may
 * still write concurrently. Same shape as `serializeGroupListWrite` for 10009.
 */
const settingsWriteChains = new Map<SettingsDocName, Promise<unknown>>();

function serializeSettingsWrite<T>(name: SettingsDocName, write: () => Promise<T>): Promise<T> {
  const chain = settingsWriteChains.get(name) ?? Promise.resolve();
  const run = chain.then(write, write);
  // Swallow the result on the chain itself so one failed write neither wedges
  // the queue nor surfaces as an unhandled rejection; the caller still gets it.
  settingsWriteChains.set(name, run.then(() => undefined, () => undefined));
  return run;
}

export interface UseSettingsDocReturn<N extends SettingsDocName> {
  /** The decrypted document, or null when none is on disk. */
  doc: SettingsDocOf<N> | null;
  /** The event it was decrypted from — identity, for "have I applied this?". */
  event: NostrRumor | null;
  isLoading: boolean;
  /** True once the store has been read at least once. */
  isFetched: boolean;
  /** Merge a patch into the document, then store and publish it. */
  update: (patch: Partial<SettingsDocOf<N>>) => Promise<SettingsDocOf<N>>;
  hasNip44Support: boolean;
}

export function useSettingsDoc<N extends SettingsDocName>(name: N): UseSettingsDocReturn<N> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
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
      const store = await eventStore;

      // Read, then write — from the store, not from this query's cache. The
      // cache is a snapshot taken whenever the query last ran; the store is
      // written the moment a new version arrives on the wire, and on Android
      // it is written by the notification service with no JS running at all.
      // Merging a patch over the cache and stamping it newest is how another
      // device's change gets reverted.
      const previous = await readSettingsDoc(store, user.signer, user.pubkey, name);
      const next = nextSettingsDoc(name, previous?.doc, patch);

      const event = await user.signer.signEvent({
        kind: SETTINGS_KIND,
        content: await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(next)),
        tags: [
          ["d", settingsDTag(name)],
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
      // A refetch already in flight (a relay echo of the PREVIOUS version
      // invalidates this key) read the store before this event existed;
      // letting it resolve after setQueryData would regress the cache to that
      // older version, and the config sync would apply it over what the user
      // just did. Cancel it — the store now supersedes anything it could carry.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<StoredSettingsDoc<N>>(queryKey, { event, doc: next });
      nostr.event(event, { signal: AbortSignal.timeout(8000) }).catch((err) => {
        console.warn(`Failed to publish ${name} settings:`, err);
      });

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

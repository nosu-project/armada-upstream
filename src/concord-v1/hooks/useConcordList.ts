import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import { useEventStore } from "@/hooks/useEventStore";
import { useAppContext } from "@/hooks/useAppContext";
import { APP_NAME } from "@/lib/platform";
import {
  addToConcordList,
  CONCORD_LIST_D_TAG,
  CONCORD_LIST_KIND,
  EMPTY_CONCORD_LIST,
  mergeConcordLists,
  refreshConcordCurrent,
  removeFromConcordList,
  type ConcordKeyBundle,
  type ConcordList,
  type ConcordListEntry,
} from "@/concord-v1/lib/concord";
import { acceptInvite, type CommunityInvite } from "@/concord-v1/lib/invite";
import { capRelays, type Community } from "@/concord-v1/lib/types";
import { readFolded, writeFolded } from "@/lib/foldedCache";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";
import type { NostrRumor } from "@/lib/nostrRumor";

/** The decrypted membership list persisted locally, with the event id it came from. */
type PersistedList = { event: NostrEvent; list: ConcordList };

/**
 * The user's Concord membership list — a NIP-44 self-encrypted, kind-30078
 * replaceable event (`d` = "armada/concord") on the app relays. Separate from
 * the kind-10009 NIP-29 directory: this list holds the community KEYS, so it
 * is the only durable record of Concord membership (lose it, lose the rooms).
 *
 * Modelled on Vector's `community/list.rs`. The list is read-merge-written
 * deterministically so a fresh relay event never clobbers a concurrent edit
 * from another device.
 */

/** A read of the list event, with a flag distinguishing "couldn't read" from "empty". */
interface ReadConcordListResult {
  list: ConcordList;
  /**
   * True when an event existed but we couldn't decrypt/parse it (signer not
   * ready, decrypt threw, bad JSON). The returned `list` is then empty but is
   * NOT authoritative — callers MUST NOT overwrite a populated list with it,
   * and the mutation MUST NOT read-modify-write on top of it (doing so would
   * republish a list that wipes the user's community keys → lost rooms).
   */
  decryptFailed: boolean;
}

/**
 * Decode-once cache for the membership-list decrypt, keyed by the list event id.
 * `useConcordList` is instantiated in many places (rail, page, action hooks,
 * notifications), and each seed effect / network refetch would otherwise run the
 * full NIP-44 decrypt of the same event independently (~100-200ms each, ×N on a
 * single load). The list event id + content are immutable, so a single in-flight
 * decrypt is shared and its result reused for the session.
 */
const listDecryptMemo = new Map<string, Promise<ReadConcordListResult>>();

/** Decrypt and parse the list event's NIP-44 self-encrypted content (memoized by event id). */
async function readConcordListEvent(
  event: NostrRumor | null,
  signer: NUser["signer"] | undefined,
  selfPubkey: string,
): Promise<ReadConcordListResult> {
  // No event at all (or no encrypted content) is a genuine, authoritative
  // "empty" — there's nothing to decrypt and nothing to lose.
  if (!event?.content) return { list: EMPTY_CONCORD_LIST, decryptFailed: false };
  // An event exists but we can't decrypt it yet (no nip44 signer): untrusted.
  if (!signer?.nip44) return { list: EMPTY_CONCORD_LIST, decryptFailed: true };

  const cached = listDecryptMemo.get(event.id);
  if (cached) return cached;

  const nip44 = signer.nip44;
  const work = (async (): Promise<ReadConcordListResult> => {
    try {
      const decrypted = await nip44.decrypt(selfPubkey, event.content);
      const parsed = JSON.parse(decrypted) as Partial<ConcordList>;
      return {
        list: {
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
        },
        decryptFailed: false,
      };
    } catch (err) {
      console.warn("Failed to decrypt Concord membership list:", err);
      // Don't memoize a transient failure — let a later call retry.
      listDecryptMemo.delete(event.id);
      return { list: EMPTY_CONCORD_LIST, decryptFailed: true };
    }
  })();
  listDecryptMemo.set(event.id, work);
  return work;
}

/** Query the latest Concord membership list from the app relays. */
export function useConcordList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = ["concord", "list", user?.pubkey];
  const foldKey = user ? `concord-list:${user.pubkey}` : null;

  // Vector-style: the membership list (room keys) is NIP-44 self-encrypted, and
  // decrypting it through a remote/extension signer on every boot is slow
  // (seconds for a bunker/NIP-07). So we decrypt ONCE, persist the DECRYPTED
  // list to local storage (same device-trust as the keys it holds), and read
  // that plaintext back on every subsequent boot — no signer round-trip. The
  // raw 30078 blob in IndexedDB stays the cross-device source of truth; the
  // network query reconciles it and refreshes this plaintext cache.
  useEffect(() => {
    if (!user || !foldKey) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;

      // 1. Plaintext-first: a previously-decrypted list paints instantly with NO
      //    decrypt and NO signer. This step is deliberately NOT gated on a ready
      //    signer: on reopen with a slow remote/bunker (NIP-46) signer, `nip44`
      //    can be unavailable for seconds, and gating this read on it would leave
      //    the membership list empty for that whole window — the Concord rail
      //    would show zero communities for rooms you're already in. The
      //    plaintext cache holds the same secrets as the device's keys, so
      //    reading it needs no signer.
      const persisted = await readFolded<PersistedList>(foldKey);
      if (cancelled) return;
      if (persisted) {
        queryClient.setQueryData(queryKey, {
          event: persisted.event ?? null,
          list: persisted.list,
        });
        return;
      }

      // 2. No plaintext yet (first run / first join): decrypt the cached blob
      //    once, then persist it for next time. This DOES need the signer, so it
      //    only runs once `nip44` is ready.
      if (!user.signer.nip44) return;
      const store = await eventStore;
      const [cached] = await store.query([
        { kinds: [CONCORD_LIST_KIND], authors: [user.pubkey], "#d": [CONCORD_LIST_D_TAG] },
      ]);
      if (cancelled || !cached) return;
      const { list } = await readConcordListEvent(cached, user.signer, user.pubkey);
      if (cancelled) return;
      const data = { event: cached as NostrEvent | null, list };
      if (!queryClient.getQueryData(queryKey)) queryClient.setQueryData(queryKey, data);
      void writeFolded(foldKey, { event: cached as NostrEvent, list } satisfies PersistedList);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, user?.signer.nip44, eventStore, queryClient]);

  type ConcordListData = { event: NostrEvent | null; list: ConcordList; decryptFailed?: boolean };

  return useQuery<ConcordListData>({
    queryKey,
    enabled: Boolean(user?.signer.nip44),
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [CONCORD_LIST_KIND], authors: [user!.pubkey], "#d": [CONCORD_LIST_D_TAG], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;

      const prev = queryClient.getQueryData<ConcordListData>(queryKey);

      // Skip the signer decrypt entirely when the network event is the same one
      // we already decrypted (matched by id) — the common case on every refresh.
      if (latest && prev?.event?.id === latest.id && !prev.decryptFailed) {
        return prev;
      }

      const { list, decryptFailed } = await readConcordListEvent(latest, user!.signer, user!.pubkey);

      // Never let a flaky/untrusted network read clobber a populated list. If we
      // couldn't decrypt the event (signer not ready, transient error), keep
      // whatever we already have — the community keys live here and a wrongful
      // empty would make the rooms (and their keys) vanish from the UI. The
      // `decryptFailed` flag rides along on the result so consumers can tell an
      // UNTRUSTED empty from a genuine empty and avoid acting on a bad read.
      if (decryptFailed) {
        return prev ?? { event: latest, list: EMPTY_CONCORD_LIST, decryptFailed: true };
      }

      // Merge the network read with what we already had (seed/cache) rather than
      // replacing it, so a transient short/empty relay read can't drop rooms.
      // `mergeConcordLists` is deterministic (tombstone-aware), so a genuine
      // remote removal still wins; this only prevents data loss from flaky reads.
      const merged = prev ? mergeConcordLists(prev.list, list) : list;
      const next: ConcordListData = { event: latest, list: merged, decryptFailed: false };
      // Persist the decrypted result so the NEXT boot reads plaintext (no signer).
      if (foldKey && latest) void writeFolded(foldKey, { event: latest, list: merged } satisfies PersistedList);
      return next;
    },
  });
}

/** A mutation against the membership list (read-modify-write, deterministic). */
type ConcordListAction =
  | { type: "add"; bundle: ConcordKeyBundle; addedAt?: number }
  | { type: "remove"; communityId: string; removedAt?: number }
  | { type: "refresh-current"; current: ConcordKeyBundle };

function applyAction(list: ConcordList, action: ConcordListAction): ConcordList {
  switch (action.type) {
    case "add":
      return addToConcordList(list, action.bundle, action.addedAt ?? Date.now());
    case "remove":
      return removeFromConcordList(list, action.communityId, action.removedAt ?? Date.now());
    case "refresh-current":
      return refreshConcordCurrent(list, action.current);
  }
}

/**
 * Mutate the Concord membership list: join/create (`add`), leave/removed
 * (`remove`), or follow a rekey/rename forward (`refresh-current`). Each call
 * reads the freshest relay state, folds in the local optimistic cache, merges
 * the local change in deterministically, and republishes — so concurrent edits
 * from other devices converge instead of clobbering. Mutations are serialized
 * on one scope and stamped with a strictly-increasing `created_at`, so rapid
 * back-to-back actions (e.g. accepting several invites) can't lose entries to
 * interleaving or replaceable-event timestamp ties. Content is NIP-44
 * self-encrypted; the event goes to app relays.
 */
export function useUpdateConcordList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const removeRailKey = useRemoveRailKey();

  return useMutation({
    // Serialize every list mutation onto one queue. Without this, TanStack runs
    // mutations concurrently, so back-to-back accepts (e.g. multiple invites)
    // each read the relay before any has published, both merge in only their own
    // community, and the last publish drops the others — nuking the list.
    scope: { id: "concord-list" },
    mutationFn: async (action: ConcordListAction) => {
      if (!user) throw new Error("User is not logged in");
      if (!user.signer.nip44) throw new Error("NIP-44 encryption not supported by this signer");

      // Read-modify-write against fresh relay state.
      const events = await nostr.query(
        [{ kinds: [CONCORD_LIST_KIND], authors: [user.pubkey], "#d": [CONCORD_LIST_D_TAG], limit: 1 }],
        { signal: AbortSignal.timeout(8000) },
      );
      const prev = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      const { list: relayList, decryptFailed } = await readConcordListEvent(prev, user.signer, user.pubkey);
      // Refuse to read-modify-write on top of a list we couldn't decrypt: the
      // community keys would read as empty and we'd republish a list that wipes
      // the user's rooms (and their keys → unrecoverable). Fail the action loud.
      if (decryptFailed) {
        throw new Error("Couldn't read your existing communities (decryption failed); not saving to avoid losing room keys.");
      }

      // Fold in what we already have locally (our own just-published optimistic
      // write). Replaceable-event propagation isn't instant, so a serialized
      // accept's relay read can still return the pre-previous-accept event; the
      // cache carries the community the prior accept added. `mergeConcordLists`
      // is deterministic + tombstone-aware, so a genuine remote removal still
      // wins — this only prevents losing an add to propagation lag.
      const cached = queryClient.getQueryData<{ event: NostrEvent | null; list: ConcordList }>([
        "concord",
        "list",
        user.pubkey,
      ]);
      const current = cached ? mergeConcordLists(cached.list, relayList) : relayList;

      // Apply the local action on top of the merged base.
      const next = applyAction(mergeConcordLists(current, EMPTY_CONCORD_LIST), action);

      // Replaceable events tie-break on lowest id at equal created_at (NIP-01),
      // which is NOT "newest content wins". Two accepts in the same wall-clock
      // second would otherwise collide and the relay could keep the stale one.
      // Force created_at strictly past the previous event so last-write-wins
      // always selects this newer, more-complete list.
      const createdAt = Math.max(Math.floor(Date.now() / 1000), (prev?.created_at ?? 0) + 1);
      const content = await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(next));
      const event = await user.signer.signEvent({
        kind: CONCORD_LIST_KIND,
        content,
        tags: [
          ["d", CONCORD_LIST_D_TAG],
          ["title", `${APP_NAME} Encrypted Communities`],
        ],
        created_at: createdAt,
      });

      queryClient.setQueryData(["concord", "list", user.pubkey], {
        event,
        list: next,
      });
      // Update the local plaintext cache so the next boot reads it without a
      // signer decrypt (we just produced `next` in the clear here).
      void writeFolded(`concord-list:${user.pubkey}`, { event, list: next } satisfies PersistedList);
      await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      return next;
    },
    onSuccess: (_next, action) => {
      // Leaving purges the rail-arrangement key too, so a later rejoin doesn't
      // reappear inside the folder it used to live in.
      if (action.type === "remove") removeRailKey(`c1:${action.communityId}`);
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    },
  });
}

/** Where a recovered community was found, so the UI can explain provenance. */
export type ConcordRecoverySource = "list-history";

/**
 * One community surfaced by a read-only resync scan, classified so the user can
 * decide what to restore. `status`:
 *   - "current": already in your active list (shown for context, not restorable);
 *   - "recovered": found in an old list version, NOT currently in your list and
 *     NOT deliberately left — a candidate to restore;
 *   - "left": you have a newer tombstone for it (you left/declined). Restoring
 *     it would override that leave, so it's opt-in and called out separately.
 */
export interface ConcordScanItem {
  communityId: string;
  name: string;
  /** Whether it's already active, recoverable, or a deliberate leave. */
  status: "current" | "recovered" | "left";
  /** Where the recovered entry came from (for "recovered"/"left"). */
  source: ConcordRecoverySource;
  /** The reconstructed entry to merge in if the user restores this one. */
  entry: ConcordListEntry;
}

/** The result of a read-only resync scan — nothing is published. */
export interface ConcordScanResult {
  /** Every community found across all sources, classified + sorted by name. */
  items: ConcordScanItem[];
  /** Count of communities already in the active list. */
  currentCount: number;
  /** The authoritative list at scan time (basis the apply step builds on). */
  baseList: ConcordList;
}

/** A read of one 30078 list blob into a {@link ConcordList} (best-effort). */
async function decodeListBlob(
  event: NostrRumor | null | undefined,
  signer: NUser["signer"],
  selfPubkey: string,
): Promise<ConcordList | null> {
  if (!event?.content) return null;
  try {
    const { list, decryptFailed } = await readConcordListEvent(event, signer, selfPubkey);
    return decryptFailed ? null : list;
  } catch {
    return null;
  }
}

/**
 * Read-only scan to recover Concord communities lost to a bad kind-30078
 * overwrite — WITHOUT publishing anything. The list is a single replaceable
 * event, so an older/out-of-sync client could replace it with a shorter list
 * and drop rooms (and their keys). This gathers membership/keys from every
 * source that still holds them and classifies each community so the user can
 * SEE what would be restored and choose, rather than firing a blind republish:
 *
 *   1. the local plaintext folded cache (survives a remote overwrite locally);
 *   2. EVERY 30078 `d=armada/concord` blob the local event store still holds;
 *   3. EVERY 30078 blob the relays return — queried WITHOUT `limit:1`, so a
 *      relay that retained a prior version contributes it.
 *
 * (The gift-wrap invite inbox is no longer a source: V1 never queries kind
 * 1059 anymore — direct invites are V2-only, and the bandwidth of scanning
 * the wrap backlog is what killed it.)
 *
 * Each found community is classified as already-current, recoverable, or a
 * deliberate leave (it has a newer tombstone) so the UI can present them
 * distinctly. The apply step ({@link useApplyConcordResync}) does the writing.
 */
export function useScanConcordList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  return useMutation<ConcordScanResult, Error, void>({
    mutationFn: async () => {
      if (!user) throw new Error("Sign in to scan your communities.");
      const signer = user.signer;
      if (!signer.nip44) {
        throw new Error("This signer can't decrypt your communities (NIP-44 unsupported).");
      }
      const pubkey = user.pubkey;

      // Sources that may contain entries. Track which provided each community
      // so the UI can show provenance.
      const listSources: ConcordList[] = [];

      // 1. Local plaintext cache.
      const persisted = await readFolded<PersistedList>(`concord-list:${pubkey}`);
      if (persisted?.list) listSources.push(persisted.list);

      // 2. Every 30078 list blob the local event store holds.
      try {
        const store = await eventStore;
        const local = await store.query([
          { kinds: [CONCORD_LIST_KIND], authors: [pubkey], "#d": [CONCORD_LIST_D_TAG] },
        ]);
        for (const ev of local) {
          const list = await decodeListBlob(ev, signer, pubkey);
          if (list) listSources.push(list);
        }
      } catch {
        // Best-effort.
      }

      // 3. Every 30078 list blob the relays return (no limit:1).
      let prev: NostrEvent | null = null;
      try {
        const remote = await nostr.query(
          [{ kinds: [CONCORD_LIST_KIND], authors: [pubkey], "#d": [CONCORD_LIST_D_TAG], limit: 100 }],
          { signal: AbortSignal.timeout(10_000) },
        );
        prev = remote.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
        for (const ev of remote) {
          const list = await decodeListBlob(ev, signer, pubkey);
          if (list) listSources.push(list);
        }
      } catch {
        // Best-effort.
      }

      // The authoritative basis: the active in-memory list, falling back to the
      // freshest decrypted relay blob. This is what "current"/"left" are judged
      // against and what the apply step merges chosen recoveries onto.
      const active =
        queryClient.getQueryData<{ list: ConcordList }>(["concord", "list", pubkey])?.list ??
        (await decodeListBlob(prev, signer, pubkey)) ??
        EMPTY_CONCORD_LIST;

      const currentIds = new Set(active.entries.map((e) => e.communityId));
      const tombstones = new Map(active.tombstones.map((t) => [t.communityId, t.removedAt]));

      // Fold every recovered entry per community, keeping the freshest bundle.
      const found = new Map<string, { entry: ConcordListEntry; source: ConcordRecoverySource }>();
      const absorb = (entries: ConcordListEntry[], source: ConcordRecoverySource) => {
        for (const e of entries) {
          const prevFound = found.get(e.communityId);
          if (!prevFound) {
            found.set(e.communityId, { entry: e, source });
          } else {
            const merged = mergeConcordLists(
              { entries: [prevFound.entry], tombstones: [] },
              { entries: [e], tombstones: [] },
            ).entries[0];
            found.set(e.communityId, { entry: merged, source: prevFound.source });
          }
        }
      };
      for (const list of listSources) absorb(list.entries, "list-history");

      const items: ConcordScanItem[] = [];
      for (const [communityId, { entry, source }] of found) {
        const name = entry.current.name || communityId.slice(0, 8);
        if (currentIds.has(communityId)) {
          items.push({ communityId, name, status: "current", source, entry });
        } else if (tombstones.has(communityId)) {
          // A real, deliberate leave — restoring overrides the tombstone.
          items.push({ communityId, name, status: "left", source, entry });
        } else {
          // Not in the list, not left → lost to a bad overwrite. Recoverable.
          items.push({ communityId, name, status: "recovered", source, entry });
        }
      }
      // Surface active communities not seen in any recovery source too, so the
      // "current" count reflects the real list.
      for (const e of active.entries) {
        if (!found.has(e.communityId)) {
          items.push({
            communityId: e.communityId,
            name: e.current.name || e.communityId.slice(0, 8),
            status: "current",
            source: "list-history",
            entry: e,
          });
        }
      }

      items.sort((a, b) => a.name.localeCompare(b.name));
      return {
        items,
        currentCount: items.filter((i) => i.status === "current").length,
        baseList: active,
      };
    },
  });
}

/**
 * Publish a resync: merge the user-chosen recovered entries onto the active
 * list and republish the kind-30078 event. Only the communities the user
 * selected in the scan are restored; everything else is left exactly as-is.
 */
export function useApplyConcordResync() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  return useMutation<{ restored: number }, Error, { baseList: ConcordList; chosen: ConcordListEntry[] }>({
    // Share the mutation queue with normal list writes so an apply can't
    // interleave with an in-flight add/remove and clobber it.
    scope: { id: "concord-list" },
    mutationFn: async ({ baseList, chosen }) => {
      if (!user) throw new Error("Sign in to restore your communities.");
      const nip44 = user.signer.nip44;
      if (!nip44) {
        throw new Error("This signer can't encrypt your communities (NIP-44 unsupported).");
      }
      const signer = user.signer;
      const pubkey = user.pubkey;
      if (chosen.length === 0) return { restored: 0 };

      // Re-read the freshest relay state and fold it in, so an apply built on a
      // slightly stale scan still merges onto the latest list (never clobbers).
      const remote = await nostr
        .query(
          [{ kinds: [CONCORD_LIST_KIND], authors: [pubkey], "#d": [CONCORD_LIST_D_TAG], limit: 1 }],
          { signal: AbortSignal.timeout(8000) },
        )
        .catch(() => [] as NostrEvent[]);
      const prev = remote.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      const relayList = (await decodeListBlob(prev, signer, pubkey)) ?? EMPTY_CONCORD_LIST;

      // For a "left" community the user chose to restore, the recovered entry's
      // addedAt=1 would lose to its newer tombstone. Re-stamp those choices with
      // a fresh addedAt so the merge resurrects them (an explicit re-join).
      const now = Date.now();
      const tombstoned = new Set(
        [...baseList.tombstones, ...relayList.tombstones].map((t) => t.communityId),
      );
      const chosenEntries = chosen.map((e) =>
        tombstoned.has(e.communityId) ? { ...e, addedAt: now } : e,
      );

      const base = mergeConcordLists(baseList, relayList);
      const next = mergeConcordLists(base, { entries: chosenEntries, tombstones: [] });

      const createdAt = Math.max(Math.floor(now / 1000), (prev?.created_at ?? 0) + 1);
      const content = await nip44.encrypt(pubkey, JSON.stringify(next));
      const event = await signer.signEvent({
        kind: CONCORD_LIST_KIND,
        content,
        tags: [
          ["d", CONCORD_LIST_D_TAG],
          ["title", `${APP_NAME} Encrypted Communities`],
        ],
        created_at: createdAt,
      });
      queryClient.setQueryData(["concord", "list", pubkey], { event, list: next });
      void writeFolded(`concord-list:${pubkey}`, { event, list: next } satisfies PersistedList);
      await nostr.event(event, { signal: AbortSignal.timeout(10_000) });

      const restored = next.entries.filter(
        (e) => !base.entries.some((b) => b.communityId === e.communityId),
      ).length;
      return { restored };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
      queryClient.invalidateQueries({ queryKey: ["concord", "invites"] });
    },
  });
}

/**
 * Rehydrate a live {@link Community} (with channel keys) from the membership
 * list entry for `communityIdHex`. The entry's `current` bundle carries the
 * full invite, so `acceptInvite` reconstructs the read material. Returns
 * undefined until the list loads or if the community isn't in the list.
 *
 * Runtime relay fan-out is the UNION of the community's own relays (sealed in
 * the invite — for a Vector community, Vector's relays) and this deployment's
 * user-configured app relays (`config.appRelays`), so Armada users
 * additionally gather on their configured infra while staying fully reachable
 * to clients on the community's original relays (cross-compat). The community's
 * own relays come FIRST so the protocol cap never drops them in favor of app
 * relays. This union is applied to the runtime Community only; the sealed
 * invite bundle is untouched, so a re-shared link still points other clients at
 * the owner's original relay set. Because it reads `config.appRelays` (not the
 * build-time default), removing an app relay in Settings actually stops the
 * client connecting to it.
 */
export function useConcordCommunity(communityIdHex: string | undefined): Community | undefined {
  const { data } = useConcordList();
  const { config } = useAppContext();
  // Memoize so the rehydrated Community keeps a STABLE identity across renders.
  // `acceptInvite` + the spread would otherwise mint a new object every render,
  // cascading fresh `community`/`channel` objects (and thus re-renders of the
  // whole Concord page subtree) on every parent render / query tick.
  return useMemo(() => {
    if (!communityIdHex || !data) return undefined;
    const entry = data.list.entries.find((e) => e.communityId === communityIdHex);
    if (!entry) return undefined;
    try {
      const bundle = entry.current.keys.invite as CommunityInvite | undefined;
      if (!bundle) return undefined;
      const community = acceptInvite(bundle);
      return { ...community, relays: capRelays([...community.relays, ...config.appRelays]) };
    } catch {
      return undefined;
    }
  }, [data, communityIdHex, config.appRelays]);
}

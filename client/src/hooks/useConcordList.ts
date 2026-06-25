import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { APP_NAME, APP_RELAYS } from "@/lib/platform";
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
} from "@/lib/concord";
import { acceptInvite, type CommunityInvite } from "@/lib/concord/invite";
import { capRelays, type Community } from "@/lib/concord/types";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";

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

/** Decrypt and parse the list event's NIP-44 self-encrypted content. */
async function readConcordListEvent(
  event: NostrEvent | null,
  signer: NUser["signer"] | undefined,
  selfPubkey: string,
): Promise<ReadConcordListResult> {
  // No event at all (or no encrypted content) is a genuine, authoritative
  // "empty" — there's nothing to decrypt and nothing to lose.
  if (!event?.content) return { list: EMPTY_CONCORD_LIST, decryptFailed: false };
  // An event exists but we can't decrypt it yet (no nip44 signer): untrusted.
  if (!signer?.nip44) return { list: EMPTY_CONCORD_LIST, decryptFailed: true };
  try {
    const decrypted = await signer.nip44.decrypt(selfPubkey, event.content);
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
    return { list: EMPTY_CONCORD_LIST, decryptFailed: true };
  }
}

/** Query the latest Concord membership list from the app relays. */
export function useConcordList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = ["concord", "list", user?.pubkey];

  // Cache-first seed: hydrate the community list (the room keys) from IndexedDB
  // so rooms survive a refresh and render before the network resolves. The
  // 30078 list event is persisted by NostrBatcher; read it back by its addr
  // coordinate and decrypt locally.
  useEffect(() => {
    if (!user?.signer.nip44) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;
      const store = await eventStore;
      const [cached] = await store.query([
        { kinds: [CONCORD_LIST_KIND], authors: [user.pubkey], "#d": [CONCORD_LIST_D_TAG] },
      ]);
      if (cancelled || !cached) return;
      const { list } = await readConcordListEvent(cached, user.signer, user.pubkey);
      if (cancelled || queryClient.getQueryData(queryKey)) return;
      queryClient.setQueryData(queryKey, { event: cached as NostrEvent | null, list });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, user?.signer.nip44, eventStore, queryClient]);

  return useQuery({
    queryKey,
    enabled: Boolean(user?.signer.nip44),
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [CONCORD_LIST_KIND], authors: [user!.pubkey], "#d": [CONCORD_LIST_D_TAG], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      const { list, decryptFailed } = await readConcordListEvent(latest, user!.signer, user!.pubkey);

      const prev = queryClient.getQueryData<{ event: NostrEvent | null; list: ConcordList }>(queryKey);

      // Never let a flaky/untrusted network read clobber a populated list. If we
      // couldn't decrypt the event (signer not ready, transient error), keep
      // whatever we already have — the community keys live here and a wrongful
      // empty would make the rooms (and their keys) vanish from the UI.
      if (decryptFailed) {
        return prev ?? { event: latest, list: EMPTY_CONCORD_LIST };
      }

      // Merge the network read with what we already had (seed/cache) rather than
      // replacing it, so a transient short/empty relay read can't drop rooms.
      // `mergeConcordLists` is deterministic (tombstone-aware), so a genuine
      // remote removal still wins; this only prevents data loss from flaky reads.
      const merged = prev ? mergeConcordLists(prev.list, list) : list;
      return { event: latest, list: merged };
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
      await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      return next;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
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
 * {@link APP_RELAYS}, so Armada users additionally gather on Armada infra while
 * staying fully reachable to clients on the community's original relays
 * (cross-compat). The community's own relays come FIRST so the protocol cap
 * never drops them in favor of app relays. This union is applied to the runtime
 * Community only; the sealed invite bundle is untouched, so a re-shared link
 * still points other clients at the owner's original relay set.
 */
export function useConcordCommunity(communityIdHex: string | undefined): Community | undefined {
  const { data } = useConcordList();
  // Memoize so the rehydrated Community keeps a STABLE identity across renders.
  // `acceptInvite` + the spread would otherwise mint a new object every render,
  // cascading fresh `community`/`channel` objects (and thus re-renders of the
  // whole Concord page subtree) on every parent render / query tick.
  return useMemo(() => {
    if (!communityIdHex || !data) return undefined;
    const entry = data.list.entries.find((e) => e.communityId === communityIdHex);
    if (!entry) return undefined;
    const bundle = entry.current.keys.invite as CommunityInvite | undefined;
    if (!bundle) return undefined;
    try {
      const community = acceptInvite(bundle);
      return { ...community, relays: capRelays([...community.relays, ...APP_RELAYS]) };
    } catch {
      return undefined;
    }
  }, [data, communityIdHex]);
}

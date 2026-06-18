import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
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
} from "@/lib/concord";
import { acceptInvite, type CommunityInvite } from "@/lib/concord/invite";
import type { Community } from "@/lib/concord/types";

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

/** Decrypt and parse the list event's NIP-44 self-encrypted content. */
async function readConcordListEvent(
  event: NostrEvent | null,
  signer: NUser["signer"] | undefined,
  selfPubkey: string,
): Promise<ConcordList> {
  if (!event?.content || !signer?.nip44) return EMPTY_CONCORD_LIST;
  try {
    const decrypted = await signer.nip44.decrypt(selfPubkey, event.content);
    const parsed = JSON.parse(decrypted) as Partial<ConcordList>;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
    };
  } catch (err) {
    console.warn("Failed to decrypt Concord membership list:", err);
    return EMPTY_CONCORD_LIST;
  }
}

/** Query the latest Concord membership list from the app relays. */
export function useConcordList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useQuery({
    queryKey: ["concord", "list", user?.pubkey],
    enabled: Boolean(user?.signer.nip44),
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [CONCORD_LIST_KIND], authors: [user!.pubkey], "#d": [CONCORD_LIST_D_TAG], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      const list = await readConcordListEvent(latest, user!.signer, user!.pubkey);
      return { event: latest as NostrEvent | null, list };
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
 * reads the freshest relay state, merges the local change in deterministically,
 * and republishes — so concurrent edits from other devices converge instead of
 * clobbering. Content is NIP-44 self-encrypted; the event goes to app relays.
 */
export function useUpdateConcordList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (action: ConcordListAction) => {
      if (!user) throw new Error("User is not logged in");
      if (!user.signer.nip44) throw new Error("NIP-44 encryption not supported by this signer");

      // Read-modify-write against fresh relay state, never the query cache.
      const events = await nostr.query(
        [{ kinds: [CONCORD_LIST_KIND], authors: [user.pubkey], "#d": [CONCORD_LIST_D_TAG], limit: 1 }],
        { signal: AbortSignal.timeout(8000) },
      );
      const prev = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      const current = await readConcordListEvent(prev, user.signer, user.pubkey);

      // Merge the existing relay state with itself first (idempotent normalize),
      // then apply the local action — both go through the deterministic merge.
      const next = applyAction(mergeConcordLists(current, EMPTY_CONCORD_LIST), action);

      const content = await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(next));
      const event = await user.signer.signEvent({
        kind: CONCORD_LIST_KIND,
        content,
        tags: [
          ["d", CONCORD_LIST_D_TAG],
          ["title", `${APP_NAME} Encrypted Communities`],
        ],
        created_at: Math.floor(Date.now() / 1000),
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
 */
export function useConcordCommunity(communityIdHex: string | undefined): Community | undefined {
  const { data } = useConcordList();
  if (!communityIdHex || !data) return undefined;
  const entry = data.list.entries.find((e) => e.communityId === communityIdHex);
  if (!entry) return undefined;
  const bundle = entry.current.keys.invite as CommunityInvite | undefined;
  if (!bundle) return undefined;
  try {
    return acceptInvite(bundle);
  } catch {
    return undefined;
  }
}

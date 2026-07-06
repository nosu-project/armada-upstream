import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useConcordList, useUpdateConcordList } from "@/concord-v1/hooks/useConcordList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { ConcordCommunity, ConcordKeyBundle } from "@/concord-v1/lib/concord";
import { unwrapGiftWrap } from "@/concord-v1/lib/giftwrap";
import {
  advanceInviteCursor,
  inviteSince,
  queryInvites,
  writeInvites,
} from "@/concord-v1/lib/inviteStore";
import { acceptInvite, buildInvite, parseInviteRumor, type CommunityInvite } from "@/concord-v1/lib/invite";
import { KIND_GIFT_WRAP } from "@/concord-v1/lib/kinds";

import type { NostrEvent } from "@nostrify/nostrify";

/** A direct Concord invite received over a gift wrap, awaiting the user's consent. */
export interface ParkedInvite {
  /** Gift-wrap event id (stable key + dedup). */
  wrapId: string;
  /** The inviter's pubkey (the seal author). */
  sender: string;
  /** The decrypted, validated join bundle. */
  invite: CommunityInvite;
  communityId: string;
  name: string;
}

/**
 * Scan the gift-wrap inbox (kind 1059 addressed to me) on the app relays for
 * direct Concord invites (kind-3304 rumors). Decrypts + validates each, and
 * **parks** it — consent comes first, exactly as Vector does: a received invite
 * never auto-joins, it waits here until the user accepts. Already-joined or
 * tombstoned communities are filtered out so the prompt doesn't re-nag.
 *
 * Sync: decrypted invite rumors are persisted in a dedicated IndexedDB store
 * (inviteStore) and read back from there, so the inbox no longer re-decrypts the
 * whole 1059 backlog on every poll. A persisted `since` cursor means only wraps
 * newer than the last sync are fetched.
 */
export function useConcordInvites() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: list, isFetched: listFetched } = useConcordList();

  const known = new Set((list?.list.entries ?? []).map((e) => e.communityId));
  const tombstoned = new Set((list?.list.tombstones ?? []).map((t) => t.communityId));

  // The membership list is "ready" once it has data (the cache seed populated
  // it, or the network resolved) OR the network query has at least completed.
  // Either way `known`/`tombstoned` then reflect real membership.
  //
  // BUT: a read we couldn't decrypt (remote/bunker signer not ready yet) yields
  // an UNTRUSTED empty list that is still `isFetched`. Treating that as ready
  // would make `known` empty and re-park invites for communities we're already
  // in — a spam of invite modals on launch with a slow NIP-46 signer. So a
  // decrypt-failed list is explicitly NOT ready; we wait for a trusted read.
  const decryptFailed = Boolean(list?.decryptFailed);
  const listReady = !decryptFailed && (list !== undefined || listFetched);

  return useQuery<ParkedInvite[]>({
    queryKey: ["concord", "invites", user?.pubkey, [...known].sort().join(","), [...tombstoned].sort().join(",")],
    // Don't scan the invite inbox until the membership list is ready. During the
    // post-refresh warmup the list is undefined/empty → the "already-joined"
    // filter (`known`) would be empty → every gift-wrap invite, INCLUDING
    // already-joined communities, would be re-parked and the invites prompt
    // would wrongly pop for rooms we're already in.
    enabled: Boolean(user?.signer.nip44) && listReady,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;

      // Fetch only wraps newer than the last sync. Decrypt just the ones we
      // don't already have stored, persist them, advance the cursor. (Invite
      // gift wraps don't backdate, so resuming from the exact cursor is safe.)
      const since = await inviteSince(pubkey);
      const filter: { kinds: number[]; "#p": string[]; limit: number; since?: number } = {
        kinds: [KIND_GIFT_WRAP],
        "#p": [pubkey],
        limit: 200,
      };
      if (since > 0) filter.since = since;
      const wraps = (await nostr.query([filter], {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      })) as NostrEvent[];

      if (wraps.length > 0) {
        const stored = new Set((await queryInvites({ signal })).map((i) => i.wrapId));
        const fresh: { wrap: NostrEvent; unwrapped: NonNullable<Awaited<ReturnType<typeof unwrapGiftWrap>>> }[] = [];
        let newestWrap = 0;
        for (const wrap of wraps) {
          if (wrap.created_at > newestWrap) newestWrap = wrap.created_at;
          if (stored.has(wrap.id)) continue;
          const unwrapped = await unwrapGiftWrap(wrap, user!.signer);
          if (!unwrapped) continue;
          fresh.push({ wrap, unwrapped });
        }
        writeInvites(fresh);
        if (newestWrap > 0) await advanceInviteCursor(pubkey, newestWrap);
      }

      // Read the parked set back from the store (decrypted, no re-decrypt), then
      // apply the consent filters against the current membership list.
      const parked = new Map<string, ParkedInvite>();
      for (const record of await queryInvites({ signal })) {
        const invite = parseInviteRumor(record.rumor.kind, record.rumor.content);
        if (!invite) continue;
        // Consent gate: skip communities we've already joined or left.
        if (known.has(invite.community_id) || tombstoned.has(invite.community_id)) continue;
        // Validate it reconstructs (drops malformed bundles) before parking.
        try {
          acceptInvite(invite);
        } catch {
          continue;
        }
        parked.set(record.wrapId, {
          wrapId: record.wrapId,
          sender: record.sender,
          invite,
          communityId: invite.community_id,
          name: invite.name,
        });
      }
      return [...parked.values()];
    },
  });
}

/** Accept a parked direct invite: reconstruct the community + add it to the membership list. */
export function useAcceptConcordInvite() {
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateConcordList();
  const queryClient = useQueryClient();

  return useMutation<ConcordCommunity, Error, { invite: CommunityInvite }>({
    mutationFn: async ({ invite }) => {
      if (!user) throw new Error("Sign in to accept an invite.");
      const community = acceptInvite(invite);
      const bundle: ConcordKeyBundle = {
        communityId: bytesToHex(community.id),
        epoch: Number(community.serverRootEpoch),
        name: community.name,
        relays: community.relays,
        keys: { invite: buildInvite(community) },
      };
      await updateList({ type: "add", bundle });
      return {
        communityId: bytesToHex(community.id),
        name: community.name,
        about: community.description,
        relays: community.relays,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "invites"] });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    },
  });
}

/** Decline a parked invite: tombstone the community so it stops re-nagging. */
export function useDeclineConcordInvite() {
  const { mutateAsync: updateList } = useUpdateConcordList();
  const queryClient = useQueryClient();

  return useMutation<void, Error, { communityId: string }>({
    mutationFn: async ({ communityId }) => {
      await updateList({ type: "remove", communityId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "invites"] });
    },
  });
}

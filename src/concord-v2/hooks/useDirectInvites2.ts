import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bundleToEntry } from "@/concord-v2/hooks/useCommunityActions2";
import { useCommunityList2, useUpdateCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  directInviteExpired,
  parseDirectInviteRumor,
  unwrapDirectInvite,
} from "@/concord-v2/lib/directInvite";
import { buildJoinRumor, currentGuestbookGroup, sealGuestbook } from "@/concord-v2/lib/guestbook";
import {
  advanceInviteInboxCursor,
  inviteInboxSince,
  queryStoredInvites,
  writeStoredInvites,
} from "@/concord-v2/lib/inviteInbox";
import { liveEntries, rehydrateCommunity } from "@/concord-v2/lib/communityList";
import type { InviteBundle } from "@/concord-v2/lib/invite";
import { KIND_DIRECT_INVITE, KIND_WRAP } from "@/concord-v2/lib/kinds";

import type { NostrEvent } from "@nostrify/nostrify";

/** A direct invite received over a gift wrap, awaiting the user's consent. */
export interface ParkedInvite2 {
  /** Gift-wrap event id (stable key + dedup). */
  wrapId: string;
  /** The inviter's pubkey (the seal author, verified). */
  sender: string;
  /** The decrypted, validated invite bundle. */
  bundle: InviteBundle;
  communityId: string;
  name: string;
}

/**
 * Scan the direct-invite inbox: the indexed CORD-05 §6 lookup
 * `{ kinds: [1059], "#p": [me], "#k": ["3313"] }` — exactly this user's
 * invites, never the whole giftwrap backlog. Each wrap is decrypted once,
 * persisted (inviteInbox), and **parked** — consent comes first: a received
 * invite never auto-joins, no relay connection or Join happens until the user
 * accepts. Already-joined or tombstoned communities are filtered out so the
 * prompt doesn't re-nag.
 */
export function useDirectInvites2() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: list, isFetched: listFetched } = useCommunityList2();

  const known = new Set(list ? liveEntries(list.list).map((e) => e.community_id) : []);
  const tombstoned = new Set((list?.list.tombstones ?? []).map((t) => t.community_id));

  // Don't scan until the membership list is trustworthy: an UNDECRYPTABLE read
  // (remote/bunker signer not ready) yields an untrusted empty list — treating
  // it as ready would re-park invites for communities we're already in and
  // spam the prompt on launch. A decrypt-failed list is explicitly NOT ready.
  const decryptFailed = Boolean(list?.decryptFailed);
  const listReady = !decryptFailed && (list !== undefined || listFetched);

  return useQuery<ParkedInvite2[]>({
    queryKey: [
      "concord2",
      "direct-invites",
      user?.pubkey,
      [...known].sort().join(","),
      [...tombstoned].sort().join(","),
    ],
    enabled: Boolean(user?.signer.nip44) && listReady,
    staleTime: 30_000,
    // Invites aren't latency-critical (the user consents whenever they get to
    // it) and the cursor means a longer gap just delays discovery, never drops
    // one. Poll slowly and only while the tab is visible.
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;

      // Fetch only wraps newer than the cursor (rewound by NIP-59's backdate
      // window — direct-invite wraps DO tweak their timestamps into the past).
      // Decrypt just the ones not already stored, persist, advance the cursor.
      const since = await inviteInboxSince(pubkey);
      const filter: { kinds: number[]; "#p": string[]; "#k": string[]; limit: number; since?: number } = {
        kinds: [KIND_WRAP],
        "#p": [pubkey],
        "#k": [String(KIND_DIRECT_INVITE)],
        limit: 200,
      };
      if (since > 0) filter.since = since;
      const wraps = (await nostr.query([filter], {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      })) as NostrEvent[];

      if (wraps.length > 0) {
        const stored = new Set((await queryStoredInvites({ signal })).map((i) => i.wrapId));
        const fresh: { wrap: NostrEvent; unwrapped: NonNullable<Awaited<ReturnType<typeof unwrapDirectInvite>>> }[] = [];
        let newestWrap = 0;
        for (const wrap of wraps) {
          if (wrap.created_at > newestWrap) newestWrap = wrap.created_at;
          if (stored.has(wrap.id)) continue;
          const unwrapped = await unwrapDirectInvite(wrap, user!.signer);
          if (!unwrapped) continue;
          fresh.push({ wrap, unwrapped });
        }
        writeStoredInvites(fresh);
        if (newestWrap > 0) await advanceInviteInboxCursor(pubkey, newestWrap);
      }

      // Read the parked set back from the store (no re-decrypt), then apply
      // the consent filters against the current membership list.
      const parked = new Map<string, ParkedInvite2>();
      for (const record of await queryStoredInvites({ signal })) {
        // The outer `k` tag was a hint; the rumor's kind + validation are the
        // authority (bounds, self-certifying owner — a forged bundle drops).
        const bundle = parseDirectInviteRumor(record.rumor.kind, record.rumor.content);
        if (!bundle) continue;
        // A dead handoff isn't worth a prompt: expired invites never park.
        if (directInviteExpired(bundle)) continue;
        // Consent gate: skip communities we've already joined or left/declined.
        if (known.has(bundle.community_id) || tombstoned.has(bundle.community_id)) continue;
        parked.set(record.wrapId, {
          wrapId: record.wrapId,
          sender: record.sender,
          bundle,
          communityId: bundle.community_id,
          name: bundle.name,
        });
      }
      return [...parked.values()];
    },
  });
}

/**
 * Accept a parked direct invite: keep the keys — record the entry in the
 * Community List vault — then announce with a self-signed Guestbook Join
 * echoing the invite's attribution (CORD-05 §6 accepts exactly like a §1
 * link acceptance).
 */
export function useAcceptDirectInvite2() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const queryClient = useQueryClient();

  return useMutation<{ communityId: string; name: string }, Error, { invite: ParkedInvite2 }>({
    mutationFn: async ({ invite }) => {
      if (!user) throw new Error("Sign in to accept an invite.");
      const { bundle } = invite;
      if (directInviteExpired(bundle)) throw new Error("This invite has expired.");

      const entry = bundleToEntry(bundle);
      await updateList({ type: "add", entry });

      // Best-effort Join, attributed to the inviter (the seal-verified sender
      // beats an unverified creator_npub claim) — coalesce self-heals if it
      // never lands.
      void (async () => {
        const community = rehydrateCommunity(entry);
        if (!community) return;
        const rumor = buildJoinRumor(user.pubkey, Date.now(), { creator: invite.sender, label: bundle.label });
        const wrap = await sealGuestbook(rumor, currentGuestbookGroup(community), user.signer);
        await Promise.allSettled(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
      })().catch(() => undefined);

      return { communityId: bundle.community_id, name: bundle.name };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord2", "direct-invites"] });
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
    },
  });
}

/** Decline a parked invite: tombstone the community so it stops re-nagging. */
export function useDeclineDirectInvite2() {
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const queryClient = useQueryClient();

  return useMutation<void, Error, { communityId: string }>({
    mutationFn: async ({ communityId }) => {
      await updateList({ type: "remove", communityId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord2", "direct-invites"] });
    },
  });
}

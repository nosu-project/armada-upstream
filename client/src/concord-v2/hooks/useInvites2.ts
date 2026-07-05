import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useControlFold2, citationFor, invalidateControl2, publishEdition2 } from "@/concord-v2/hooks/useControlPlane2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { buildRegistryEdition } from "@/concord-v2/lib/control";
import { bytesToHex, hexToBytes, inviteLinksLocator, hex32 } from "@/concord-v2/lib/derive";
import {
  buildBundleEvent,
  buildInviteUrl,
  buildRevocationEvent,
  EMPTY_INVITE_LIST,
  mergeInviteLists,
  mintLinkSigner,
  mintToken,
  parseInviteLink,
  type InviteBundle,
  type InviteList,
} from "@/concord-v2/lib/invite";
import { KIND_INVITE_LIST } from "@/concord-v2/lib/kinds";
import type { CommunityV2 } from "@/concord-v2/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";

/**
 * The creator's Invite List (kind 13303, CORD-05 §4): private bookkeeping for
 * minted links — the unlock token AND the link-signer secret live here, synced
 * across the creator's devices, NIP-44-encrypted to self.
 */
const inviteListKey = (pubkey: string | undefined) => ["concord2", "invite-list", pubkey] as const;

async function readInviteList(
  event: NostrEvent | null,
  signer: NUser["signer"],
  selfPubkey: string,
): Promise<InviteList | null> {
  if (!event?.content || !signer.nip44) return null;
  try {
    const decrypted = await signer.nip44.decrypt(selfPubkey, event.content);
    const parsed = JSON.parse(decrypted) as Partial<InviteList>;
    return {
      ...parsed,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
    } as InviteList;
  } catch {
    return null;
  }
}

export function useInviteList2() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useQuery<InviteList>({
    queryKey: inviteListKey(user?.pubkey),
    enabled: Boolean(user?.signer.nip44),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [KIND_INVITE_LIST], authors: [user!.pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      return (await readInviteList(latest, user!.signer, user!.pubkey)) ?? EMPTY_INVITE_LIST;
    },
  });
}

/** Read-merge-write the Invite List (serialized on one scope). */
function useUpdateInviteList2() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  return useMutation({
    scope: { id: "concord2-invite-list" },
    mutationFn: async (patch: InviteList) => {
      if (!user?.signer.nip44) throw new Error("NIP-44 unsupported.");
      const events = await nostr.query(
        [{ kinds: [KIND_INVITE_LIST], authors: [user.pubkey], limit: 1 }],
        { signal: AbortSignal.timeout(8000) },
      );
      const prev = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      const remote = (await readInviteList(prev, user.signer, user.pubkey)) ?? EMPTY_INVITE_LIST;
      const cached = queryClient.getQueryData<InviteList>(inviteListKey(user.pubkey)) ?? EMPTY_INVITE_LIST;
      const next = mergeInviteLists(mergeInviteLists(remote, cached), patch);

      const createdAt = Math.max(Math.floor(Date.now() / 1000), (prev?.created_at ?? 0) + 1);
      const content = await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(next));
      const event = await user.signer.signEvent({ kind: KIND_INVITE_LIST, content, tags: [], created_at: createdAt });
      queryClient.setQueryData(inviteListKey(user.pubkey), next);
      await nostr.event(event, { signal: AbortSignal.timeout(8000) });
      return next;
    },
  });
}

/**
 * Mint / revoke public invite links for one community (CORD-05):
 *
 *   - MINT: fresh 16-byte token + fresh link-signer keypair; the encrypted
 *     bundle posts at `(33301, link_signer, d="")` on the community's relays;
 *     the link is `<base>/invite/<naddr>#<fragment>`; the Invite List records
 *     the secrets; the member-facing Registry (vsk 8) lists the coordinate.
 *   - REVOKE: the coordinate is re-posted as a tombstone (creator-only — needs
 *     the link-signer secret), the Registry drops it, the Invite List
 *     tombstones it. Retiring the last live link is what flips the Community
 *     back to Private.
 */
export function useInviteActions2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold2(community);
  const inviteList = useInviteList2();
  const { mutateAsync: updateInviteList } = useUpdateInviteList2();

  /** Publish this creator's registry (vsk 8) with the given live link set. */
  const publishRegistry = async (linkSigners: string[]) => {
    if (!user || !community) return;
    const eid = bytesToHex(inviteLinksLocator(community.id, hex32(user.pubkey)));
    const head = folded?.heads.get(eid);
    await publishEdition2(
      nostr,
      community,
      user.signer,
      buildRegistryEdition(community.id, user.pubkey, linkSigners, {
        actorPubkey: user.pubkey,
        version: head ? head.version + 1n : 1n,
        prevHash: head?.hash,
        authority: citationFor(community, folded, user.pubkey),
      }),
    ).catch(() => undefined);
    invalidateControl2(queryClient, community.idHex);
  };

  const createLink = useMutation<string, Error, { expiresAtMs?: number; label?: string }>({
    mutationFn: async ({ expiresAtMs, label }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (!user.signer.nip44) throw new Error("This signer can't mint invite links (NIP-44 unsupported).");

      const token = mintToken();
      const link = mintLinkSigner();

      const bundle: InviteBundle = {
        community_id: community.idHex,
        owner: community.owner,
        owner_salt: bytesToHex(community.ownerSalt),
        community_root: bytesToHex(community.root),
        root_epoch: Number(community.rootEpoch),
        channels: community.privateChannels.map((ch) => ({
          id: bytesToHex(ch.id),
          key: bytesToHex(ch.key),
          epoch: Number(ch.epoch),
          name: ch.name,
        })),
        relays: community.relays,
        name: folded?.metadata?.name ?? community.name,
        ...(folded?.metadata?.icon ? { icon: folded.metadata.icon } : {}),
        ...(expiresAtMs ? { expires_at: expiresAtMs } : {}),
        creator_npub: user.pubkey,
        ...(label ? { label } : {}),
      };

      const bundleEvent = buildBundleEvent(bundle, token, link.sk);
      const results = await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(bundleEvent, { signal: AbortSignal.timeout(8000) })),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error("No relay accepted the invite bundle.");
      }

      const url = buildInviteUrl(window.location.origin, link.pk, token, community.relays);

      // The creator's private bookkeeping (the merge key is the token).
      await updateInviteList({
        entries: [
          {
            token: bytesToHex(token),
            signer_sk: bytesToHex(link.sk),
            community_id: community.idHex,
            url,
            ...(label ? { label } : {}),
            created_at: Math.floor(Date.now() / 1000),
            ...(expiresAtMs ? { expires_at: Math.floor(expiresAtMs / 1000) } : {}),
          },
        ],
        tombstones: [],
      });

      // The member-facing Registry: this creator's live coordinates.
      const mine = new Set(folded?.registriesByCreator.get(user.pubkey) ?? []);
      mine.add(link.pk);
      await publishRegistry([...mine]);

      return url;
    },
  });

  const revokeLink = useMutation<void, Error, { url: string }>({
    mutationFn: async ({ url }) => {
      if (!user || !community) throw new Error("Not ready.");
      const parsed = parseInviteLink(url);
      if (!parsed) throw new Error("Not a recognizable invite link.");

      // The signer secret lives in the Invite List (only the creator holds it).
      const entry = inviteList.data?.entries.find(
        (e) => e.community_id === community.idHex && parseInviteLink(e.url)?.linkSigner === parsed.linkSigner,
      );
      if (!entry) throw new Error("This device doesn't hold that link's signing secret.");

      const tomb = buildRevocationEvent(hexToBytes(entry.signer_sk));
      const results = await Promise.allSettled(
        community.relays.map((relay) => nostr.relay(relay).event(tomb, { signal: AbortSignal.timeout(8000) })),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error("No relay accepted the revocation.");
      }

      await updateInviteList({
        entries: [],
        tombstones: [{ token: entry.token, community_id: community.idHex }],
      });

      const mine = new Set(folded?.registriesByCreator.get(user.pubkey) ?? []);
      mine.delete(parsed.linkSigner);
      await publishRegistry([...mine]);
    },
  });

  /** This creator's live links for THIS community (from the private list). */
  const myLinks = (inviteList.data?.entries ?? []).filter((e) => e.community_id === community?.idHex);

  return {
    createLink: createLink.mutateAsync,
    isCreatingLink: createLink.isPending,
    revokeLink: revokeLink.mutateAsync,
    isRevoking: revokeLink.isPending,
    myLinks,
    /** Whether ANY live public link exists — the community's Public/Private flag. */
    isPublic: (folded?.liveInviteLinks.size ?? 0) > 0,
  };
}

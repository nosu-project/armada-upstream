import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useControlFold, citationFor, invalidateControl, publishEdition } from "@/concord/hooks/useControlPlane";
import { useCommunity } from "@/concord/hooks/useCommunityList";
import { resolveBundle } from "@/concord/hooks/useCommunityActions";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { selfStateRelays } from "@/contexts/AppContext";
import { buildRegistryEdition } from "@/concord/lib/control";
import { vendableChannels, type VendAudience } from "@/concord/lib/channelAccess";
import { isAuthorized, Permissions } from "@/concord/lib/roles";
import { bytesToHex, grantLocator, hexToBytes, inviteLinksLocator, hex32 } from "@/concord/lib/derive";
import {
  buildDirectInviteRumor,
  sealDirectInvite,
  wrapDirectInvite,
} from "@/concord/lib/directInvite";
import {
  buildBundleEvent,
  buildInviteUrl,
  buildRefreshedBundleEvents,
  buildRevocationEvent,
  capBundleDescription,
  EMPTY_INVITE_LIST,
  InviteError,
  mergeInviteLists,
  mintLinkSigner,
  mintToken,
  parseInviteLink,
  shareableInviteUrl,
  STOCK_RELAYS,
  type InviteBundle,
  type InviteList,
} from "@/concord/lib/invite";
import { KIND_INVITE_LIST } from "@/concord/lib/kinds";
import { buildCommunityAnnouncement } from "@/concord/lib/inviteDiscovery";
import { inviteDeliveryRelays, recipientInboxRelays } from "@/concord/lib/inviteRelays";
import { publishToAnyRelay } from "@/concord/lib/relayPublish";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { toast } from "@/hooks/useToast";
import { linkStoreBase, shareOrigin } from "@/lib/shareOrigin";
import {
  publishSignedEventToRelays,
  queryExplicitRelaysWithStatus,
  uniqueRelayUrls,
} from "@/lib/nip65";
import {
  queueSignedEvent,
  recordQueuedPublishAttempt,
} from "@/lib/publishOutbox";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { isSigned, type NostrRumor } from "@/lib/nostrRumor";
import type { Community } from "@/concord/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";

/**
 * The creator's Invite List (kind 13303, CORD-05 §4): private bookkeeping for
 * minted links — the unlock token AND the link-signer secret live here, synced
 * across the creator's devices, NIP-44-encrypted to self.
 */
export const inviteListKey = (pubkey: string | undefined) => ["concord", "invite-list", pubkey] as const;
export const inviteListFoldKey = (pubkey: string) => `concord2-invite-list:${pubkey}`;

export interface PersistedInviteList {
  list: InviteList;
  newestCreatedAt: number;
  /** A merge-only local patch still needs a signed relay reconciliation. */
  needsPublish?: boolean;
}

export function readPersistedInviteList(pubkey: string): Promise<PersistedInviteList | undefined> {
  return readFolded<PersistedInviteList>(inviteListFoldKey(pubkey));
}

/** Explicit NIP-65/account destinations plus the fixed CORD rescue floor. */
export function inviteListRelays(selfRelays: Iterable<string>): string[] {
  return uniqueRelayUrls([...selfRelays, ...STOCK_RELAYS]);
}

/** Queue exact signed bytes, fan every target independently, retain misses. */
export async function publishInviteListEvent(
  nostr: Pick<ReturnType<typeof useNostr>["nostr"], "relay">,
  event: NostrEvent,
  relayUrls: Iterable<string>,
): Promise<{ accepted: string[]; rejected: string[] }> {
  const targets = uniqueRelayUrls(relayUrls);
  if (targets.length === 0) throw new Error("No relay is available for creator invite recovery");
  // A creator-list update changes revocation authority. Never start a partial
  // fan-out unless the exact signed event and every target are durable first.
  await queueSignedEvent(event, undefined, targets, { inheritPendingTargets: false });
  const result = await publishSignedEventToRelays(nostr, event, targets, 8_000);
  await recordQueuedPublishAttempt(event.id, targets, result.rejected).catch(() => undefined);
  if (result.accepted.length === 0) {
    throw new Error("No relay accepted your creator invite list update");
  }
  return result;
}

export async function readInviteList(
  event: NostrRumor | null,
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

export interface DecodedInviteLists {
  list: InviteList;
  newestCreatedAt: number;
  newestEvent: NostrRumor | null;
  /** The NIP-01 head could not be decrypted/parsed; writes must fail closed. */
  unreadable: boolean;
  /** The newest exact wire event already contains the full semantic union. */
  exactEvent: NostrEvent | null;
}

/** Fold all currently visible relay copies while retaining an exact mirror when safe. */
export async function decodeInviteListEvents(
  sourceEvents: Iterable<NostrRumor>,
  user: NUser,
): Promise<DecodedInviteLists> {
  const events = [...new Map([...sourceEvents].map((event) => [event.id, event])).values()]
    .filter((event) => event.kind === KIND_INVITE_LIST && event.pubkey === user.pubkey)
    // Oldest first; on a timestamp tie the NIP-01 winner (lowest id) is last.
    .sort((a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id));
  let list = EMPTY_INVITE_LIST;
  const decoded = new Map<string, InviteList>();
  for (const event of events) {
    const copy = await readInviteList(event, user.signer, user.pubkey);
    if (!copy) continue;
    decoded.set(event.id, copy);
    list = mergeInviteLists(list, copy);
  }
  const newestEvent = [...events]
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0] ?? null;
  const newestCopy = newestEvent ? decoded.get(newestEvent.id) : undefined;
  const unreadable = Boolean(newestEvent && !newestCopy);
  const exactEvent = newestEvent && isSigned(newestEvent)
    && newestCopy && JSON.stringify(newestCopy) === JSON.stringify(list)
    ? newestEvent
    : null;
  return {
    list,
    newestCreatedAt: newestEvent?.created_at ?? 0,
    newestEvent,
    unreadable,
    exactEvent,
  };
}

/**
 * Fetch and decrypt the user's Invite List, merging every copy that reaches us
 * rather than trusting a single newest event: tombstones union and win
 * terminally (CORD-05 §4). Also returns the newest `created_at` seen, for
 * replaceable-event monotonicity on write.
 *
 * The merge here is defensive, NOT the guarantee — `NPool.query` collects into
 * an `NSet`, which applies replaceable semantics itself and hands back at most
 * ONE 13303 (the newest that arrived inside the pool's ~300ms EOSE window). So
 * a pool answered only by relays that haven't yet indexed our latest write
 * returns a list that is genuinely BEHIND, tombstones and all. Every caller
 * therefore merges this result into what it already holds and never assigns it
 * over the top — see {@link useInviteList} and {@link useUpdateInviteList}.
 */
export async function fetchInviteList(
  nostr: ReturnType<typeof useNostr>["nostr"],
  user: NUser,
  signal?: AbortSignal,
  relayUrls?: Iterable<string>,
): Promise<{
  list: InviteList;
  newestCreatedAt: number;
  unreadable: boolean;
  answered: string[];
  failed: string[];
  targets: string[];
}> {
  const filter = [{ kinds: [KIND_INVITE_LIST], authors: [user.pubkey], limit: 1 }];
  const deadline = signal ?? AbortSignal.timeout(8000);
  const targets = relayUrls ? uniqueRelayUrls(relayUrls) : [];
  const response = relayUrls
    ? await queryExplicitRelaysWithStatus(nostr, targets, filter, deadline)
    : {
        events: await nostr.query(filter, { signal: deadline }),
        answered: [] as string[],
        failed: [] as string[],
      };
  const events = response.events;
  const decoded = await decodeInviteListEvents(events, user);
  return {
    list: decoded.list,
    newestCreatedAt: decoded.newestCreatedAt,
    unreadable: decoded.unreadable,
    answered: response.answered,
    failed: response.failed,
    targets,
  };
}

export function useInviteList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { config } = useAppContext();

  return useQuery<InviteList>({
    queryKey: inviteListKey(user?.pubkey),
    enabled: Boolean(user?.signer.nip44),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const persisted = await readPersistedInviteList(user!.pubkey);
      const { list, newestCreatedAt, unreadable, answered } = await fetchInviteList(
        nostr,
        user!,
        AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        inviteListRelays(selfStateRelays(config, user!.pubkey)),
      );
      // A network read may only WIDEN this device's list, never narrow it.
      // Publishing the 13303 echoes it back on NostrSync's standing self-sync
      // sub, which invalidates this query — so a revoke's refetch races the
      // relays' indexing of the write that caused it, and a pool answering
      // from the pre-revocation copy would hand back the entry we just
      // tombstoned. Assigning that over the cache is what made a revoked link
      // reappear a moment after vanishing. Merging is sound in both
      // directions: entries are immutable once minted and keyed by token, and
      // tombstones are terminal (CORD-05 §4), so folding the cache forward can
      // only preserve facts, never invent or resurrect one.
      const cached = queryClient.getQueryData<InviteList>(inviteListKey(user!.pubkey));
      const local = cached && persisted
        ? mergeInviteLists(persisted.list, cached)
        : (cached ?? persisted?.list);
      const merged = local ? mergeInviteLists(local, list) : list;
      const foldKey = inviteListFoldKey(user!.pubkey);
      const newestFoldAt = Math.max(newestCreatedAt, persisted?.newestCreatedAt ?? 0);
      await writeFolded(foldKey, {
        list: merged,
        newestCreatedAt: newestFoldAt,
        ...(persisted?.needsPublish ? { needsPublish: true } : {}),
      } satisfies PersistedInviteList);

      // A mint/revoke is folded before its network read, so an offline attempt
      // leaves `needsPublish` behind. The next successful full read merges that
      // durable patch with every visible relay copy and reconciles it to only
      // the answered cohort. This is what turns local survival into eventual
      // cross-device recovery rather than waiting for another invite edit.
      if (persisted?.needsPublish) {
        const wireAlreadyContainsFold = JSON.stringify(merged) === JSON.stringify(list);
        if (wireAlreadyContainsFold) {
          await writeFolded(foldKey, {
            list: merged,
            newestCreatedAt: newestFoldAt,
          } satisfies PersistedInviteList);
        } else {
          const canonical = uniqueRelayUrls(selfStateRelays(config, user!.pubkey));
          const requiredFloor = canonical.length > 0 ? canonical : uniqueRelayUrls(STOCK_RELAYS);
          const canReconcile = !unreadable
            && answered.some((url) => requiredFloor.includes(url));
          if (canReconcile) {
            const createdAt = Math.max(
              Math.floor(Date.now() / 1000),
              newestCreatedAt + 1,
              (persisted.newestCreatedAt ?? 0) + 1,
            );
            try {
              const content = await user!.signer.nip44!.encrypt(
                user!.pubkey,
                JSON.stringify(merged),
              );
              const event = await user!.signer.signEvent({
                kind: KIND_INVITE_LIST,
                content,
                tags: [],
                created_at: createdAt,
              });
              await writeFolded(foldKey, {
                list: merged,
                newestCreatedAt: createdAt,
                needsPublish: true,
              } satisfies PersistedInviteList);
              await publishInviteListEvent(nostr, event, answered);
              await writeFolded(foldKey, {
                list: merged,
                newestCreatedAt: createdAt,
              } satisfies PersistedInviteList);
            } catch (error) {
              // Keep the durable dirty marker. A later refetch retries, while
              // an event that made it into the outbox retries exact bytes too.
              console.warn("Failed to reconcile creator invite recovery state:", error);
            }
          }
        }
      }
      return merged;
    },
  });
}

/**
 * The epoch each of my live links CURRENTLY vends, keyed by token (CORD-05 §2).
 * A link's coordinate is re-posted on rekey, so its bundle's `root_epoch` may
 * lag the community while the creator hasn't refreshed it (offline during a
 * rotation, a non-NIP-44 signer, etc.) — comparing this against the community's
 * live `rootEpoch` is how the UI flags a link a fresh joiner would land behind.
 * Best-effort per link: an unresolvable link (revoked/expired/offline relay) is
 * simply absent from the map rather than failing the whole query.
 */
export function useMyLinkEpochs(community: Community | undefined) {
  const { nostr } = useNostr();
  const inviteList = useInviteList();

  const links = (inviteList.data?.entries ?? []).filter((e) => e.community_id === community?.idHex);

  return useQuery<Record<string, number>>({
    queryKey: ["concord", "invite-epochs", community?.idHex, links.map((e) => e.token).sort()],
    enabled: Boolean(community && links.length > 0),
    staleTime: 60_000,
    queryFn: async () => {
      const out: Record<string, number> = {};
      await Promise.all(
        links.map(async (e) => {
          const parsed = parseInviteLink(e.url);
          if (!parsed) return;
          try {
            const bundle = await resolveBundle(nostr, parsed, community!.relays);
            if (typeof bundle.root_epoch === "number") out[e.token] = bundle.root_epoch;
          } catch {
            // Revoked/expired/offline: leave it absent (no notice, not "behind").
          }
        }),
      );
      return out;
    },
  });
}

/** Read-merge-write the Invite List (serialized on one scope). */
export async function updateInviteList(
  nostr: ReturnType<typeof useNostr>["nostr"],
  user: NUser,
  queryClient: QueryClient,
  canonicalRelays: string[],
  patch: InviteList,
): Promise<InviteList> {
  if (!user.signer.nip44) throw new Error("NIP-44 unsupported.");
  const canonical = uniqueRelayUrls(canonicalRelays);
  const relays = inviteListRelays(canonical);
  const persisted = await readPersistedInviteList(user.pubkey);
  const cached = queryClient.getQueryData<InviteList>(inviteListKey(user.pubkey)) ?? EMPTY_INVITE_LIST;
  const durable = persisted?.list ?? EMPTY_INVITE_LIST;
  const optimistic = mergeInviteLists(mergeInviteLists(durable, cached), patch);

  // A mint patch contains the only copy of signer_sk. Make that merge durable
  // and verify the read-back before the first network await, so an offline
  // source read or process kill cannot make an already-shared link irrevocable.
  await writeFolded(inviteListFoldKey(user.pubkey), {
    list: optimistic,
    newestCreatedAt: persisted?.newestCreatedAt ?? 0,
    needsPublish: true,
  } satisfies PersistedInviteList);
  const verified = await readPersistedInviteList(user.pubkey);
  if (!verified || JSON.stringify(verified.list) !== JSON.stringify(optimistic)) {
    throw new Error("Creator invite recovery state could not be saved locally");
  }
  queryClient.setQueryData(inviteListKey(user.pubkey), optimistic);

  const read = await fetchInviteList(nostr, user, undefined, relays);
  if (read.unreadable) {
    throw new Error(
      "Couldn't decrypt the current creator invite list; not saving to avoid losing revocation secrets.",
    );
  }
  const requiredFloor = canonical.length > 0 ? canonical : uniqueRelayUrls(STOCK_RELAYS);
  if (!read.answered.some((url) => requiredFloor.includes(url))) {
    throw new Error(
      "Couldn't confirm your creator invite list on an account-state relay; not saving to avoid overwriting it.",
    );
  }
  const next = mergeInviteLists(
    mergeInviteLists(read.list, optimistic),
    patch,
  );

  const createdAt = Math.max(
    Math.floor(Date.now() / 1000),
    read.newestCreatedAt + 1,
    (persisted?.newestCreatedAt ?? 0) + 1,
  );
  const content = await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(next));
  const event = await user.signer.signEvent({
    kind: KIND_INVITE_LIST,
    content,
    tags: [],
    created_at: createdAt,
  });
  queryClient.setQueryData(inviteListKey(user.pubkey), next);
  await writeFolded(inviteListFoldKey(user.pubkey), {
    list: next,
    newestCreatedAt: createdAt,
    needsPublish: true,
  } satisfies PersistedInviteList);
  await publishInviteListEvent(nostr, event, read.answered);
  await writeFolded(inviteListFoldKey(user.pubkey), {
    list: next,
    newestCreatedAt: createdAt,
  } satisfies PersistedInviteList);
  return next;
}

function useUpdateInviteList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { config } = useAppContext();

  return useMutation({
    scope: { id: "concord-invite-list" },
    mutationFn: async (patch: InviteList) => {
      if (!user?.signer.nip44) throw new Error("NIP-44 unsupported.");
      // Fold the patch into the local cache before anything that can fail: for
      // a mint the patch carries the ONLY copy of `signer_sk`, and createLink
      // no longer blocks on this write — so the cache, not the publish, is
      // what keeps a just-shared link revocable from this device when the
      // read-merge below can't reach the relays. Merge is idempotent by token,
      // so re-merging the patch into `next` is harmless.
      return updateInviteList(
        nostr,
        user,
        queryClient,
        selfStateRelays(config, user.pubkey),
        patch,
      );
    },
  });
}


/**
 * Invite actions for one community (CORD-05) — public links + direct handoffs:
 *
 *   - MINT: fresh 16-byte token + fresh link-signer keypair; the encrypted
 *     bundle posts at `(33301, link_signer, d="")` on the community's relays;
 *     the link is `<base>/invite/<naddr>#<fragment>`; the Invite List records
 *     the secrets; the member-facing Registry (vsk 8) lists the coordinate.
 *   - REVOKE: the coordinate is re-posted as a tombstone (creator-only — needs
 *     the link-signer secret), the Registry drops it, the Invite List
 *     tombstones it. Retiring the last live link is what flips the Community
 *     back to Private.
 *   - DIRECT: the bundle giftwraps straight to a known npub (CORD-05 §6) —
 *     no link, no Registry entry, nothing revocable, never flips Public.
 */
export function useInviteActions(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);
  const inviteList = useInviteList();
  const { mutateAsync: updateInviteList } = useUpdateInviteList();
  const { mutateAsync: publishEvent } = useNostrPublish();
  // The freshest membership snapshot from the live Community List vault. The
  // `community` prop is a memoized snapshot that can lag a just-adopted rekey
  // (staleTime/poll/render windows), and a bundle minted from a stale snapshot
  // would embed an OLD epoch — the exact defect that strands a fresh joiner on
  // a dead epoch (CORD-05 §2 requires the CURRENT keys). Reconcile against this.
  const fresh = useCommunity(community?.idHex);

  /**
   * The community to mint a bundle from: whichever of the caller's snapshot and
   * the live-list entry holds the HIGHER epoch. Monotonic — never mints below
   * what either source knows, so a lagging snapshot can't emit a stale bundle.
   */
  const bundleSource = (): Community | undefined => {
    if (!community) return fresh;
    if (!fresh) return community;
    return fresh.rootEpoch > community.rootEpoch ? fresh : community;
  };

  /**
   * The §1 CommunityInvite bundle: everything membership is (link + direct
   * alike).
   *
   * `audience` is required rather than defaulted, because the default is the
   * whole defect: a bundle built without asking who it is for carries every
   * Private Channel key the creator holds to whoever opens it, which makes
   * CORD-03 §1's "readable only by granted role-holders" false. A link is
   * entitled to nothing; a member is entitled to what their Roles scope them
   * to (CORD-04 §2).
   */
  const buildBundle = (
    audience: VendAudience,
    opts?: {
      expiresAtMs?: number;
      label?: string;
      /** Narrow the grant further (a role-grant vend hands over just that role's channels). */
      onlyChannelIdHexes?: ReadonlySet<string>;
    },
  ): InviteBundle => {
    if (!user) throw new Error("Not ready.");
    const src = bundleSource();
    if (!src) throw new Error("Not ready.");
    const vendable = vendableChannels(src.privateChannels, audience, {
      only: opts?.onlyChannelIdHexes,
    });
    return {
      community_id: src.idHex,
      owner: src.owner,
      owner_salt: bytesToHex(src.ownerSalt),
      community_root: bytesToHex(src.root),
      root_epoch: Number(src.rootEpoch),
      // Read access to the Control Plane, never write (CORD-02 §7); absent on
      // a legacy pre-split epoch.
      ...(src.controlPk ? { control_pk: src.controlPk } : {}),
      channels: vendable.map((ch) => ({
        id: bytesToHex(ch.id),
        key: bytesToHex(ch.key),
        epoch: Number(ch.epoch),
        name: ch.name,
      })),
      relays: src.relays,
      name: folded?.metadata?.name ?? src.name,
      ...(folded?.metadata?.icon ? { icon: folded.metadata.icon } : {}),
      ...(folded?.metadata?.banner ? { banner: folded.metadata.banner } : {}),
      ...(folded?.metadata?.description?.trim()
        ? { description: capBundleDescription(folded.metadata.description.trim()) }
        : {}),
      ...(opts?.expiresAtMs ? { expires_at: opts.expiresAtMs } : {}),
      creator_npub: user.pubkey,
      ...(opts?.label ? { label: opts.label } : {}),
    };
  };

  /** Link-signer pubkeys of MY expired links for this community. */
  const myExpiredSigners = (): Set<string> => {
    const out = new Set<string>();
    const now = Math.floor(Date.now() / 1000);
    for (const e of inviteList.data?.entries ?? []) {
      if (e.community_id !== community?.idHex || !e.expires_at || e.expires_at > now) continue;
      const p = parseInviteLink(e.url);
      if (p) out.add(p.linkSigner);
    }
    return out;
  };

  /**
   * Publish this creator's registry (vsk 8) with the given live link set.
   * Expired links are pruned first: they can't be joined, so they must not
   * keep the community reading Public (CORD-05 §5).
   */
  const publishRegistry = async (linkSigners: string[]) => {
    if (!user || !community) return;
    const expired = myExpiredSigners();
    const live = linkSigners.filter((s) => !expired.has(s));
    const eid = bytesToHex(inviteLinksLocator(community.id, hex32(user.pubkey)));
    const head = folded?.heads.get(eid);
    await publishEdition(
      nostr,
      community,
      user.signer,
      buildRegistryEdition(community.id, user.pubkey, live, {
        actorPubkey: user.pubkey,
        version: head ? head.version + 1n : 1n,
        prevHash: head?.hash,
        authority: citationFor(community, folded, user.pubkey),
      }),
    ).catch(() => undefined);
    invalidateControl(queryClient, community.idHex);
  };

  const createLink = useMutation<
    string,
    Error,
    {
      expiresAtMs?: number;
      label?: string;
      /**
       * Opt-in: also publish a PUBLIC community announcement (kind 3314)
       * carrying the full shareable link (fragment included), so Discover can
       * list it. This deliberately trades the link's secrecy for
       * discoverability; only ever set from an explicit user action.
       */
      listPublicly?: boolean;
    }
  >({
    mutationFn: async ({ expiresAtMs, label, listPublicly }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (!user.signer.nip44) throw new Error("This signer can't mint invite links (NIP-44 unsupported).");

      // Warn (don't refuse — localhost/LAN quickstarts are a supported flow)
      // when the invite will embed relays that secure platforms can't reach:
      // Android/desktop builds run on a secure origin where ws:// is blocked
      // as mixed content, so an all-ws:// community is dead for them (#47).
      const insecure = community.relays.filter((url) => !/^wss:\/\//i.test(url));
      if (insecure.length > 0) {
        const fatal = insecure.length === community.relays.length;
        toast({
          title: fatal ? "This invite won't work on mobile" : "Some relays won't work on mobile",
          description:
            `${insecure.join(", ")} ${insecure.length === 1 ? "is" : "are"} not wss:// — ` +
            `mobile and desktop apps can't connect to insecure relays` +
            (fatal ? ", so members joining from them won't be able to participate at all." : "."),
          variant: fatal ? "destructive" : undefined,
        });
      }

      const token = mintToken();
      const link = mintLinkSigner();
      // A link's audience is whoever the URL reaches (CORD-05 §2), who holds
      // no Role and is therefore entitled to no Private Channel. Access to one
      // is handed out by granting its scoped Role, which vends the key by
      // Direct Invite.
      const bundle = buildBundle({ kind: "link" }, { expiresAtMs, label });
      const bundleEvent = buildBundleEvent(bundle, token, link.sk);
      // The URL is decided LOCALLY — the naddr names the freshly minted signer
      // and the fragment carries the freshly minted token, so no write below
      // feeds into it. That is what lets the writes run concurrently.
      //
      // Store on the re-basable base (the page origin on web, a canonical
      // sentinel on native/desktop where the runtime origin is unreachable) and
      // hand out the same URL re-based onto today's share origin — the exact
      // transform `myLinks` applies to a synced entry, so a fresh mint and a
      // later read of this same entry agree. Storing a concrete origin here is
      // what pinned every link to armada.buzz.
      const storedUrl = buildInviteUrl(linkStoreBase(), link.pk, token, community.relays);
      const url = shareableInviteUrl(shareOrigin(), storedUrl);

      // The member-facing Registry: this creator's live coordinates.
      const mine = new Set(folded?.registriesByCreator.get(user.pubkey) ?? []);
      mine.add(link.pk);

      // Opt-in public community announcement (best-effort — a failed post must
      // not fail the mint; the link itself is already live).
      const announcement = listPublicly ? buildCommunityAnnouncement({ inviteUrl: url }) : null;

      // The bundle is the ONLY write that makes the link joinable, so it is the
      // only one the caller waits on. Awaiting the others in series made the
      // mint the sum of several round trips (each with its own 8s ceiling)
      // before the user could be handed a URL that had been valid since the
      // first one landed.
      await publishToAnyRelay(nostr, community.relays, bundleEvent, "No relay accepted the invite bundle.");

      // The creator's private bookkeeping (the merge key is the token).
      // `signer_sk` exists nowhere else, so losing this write costs the ability
      // to revoke — but it is optimistically cached before it publishes, so the
      // secret is on this device either way, and a failure here used to be
      // reported as "couldn't create the link" for a link that was already
      // live, which invites minting a second one.
      void updateInviteList({
        entries: [
          {
            token: bytesToHex(token),
            signer_sk: bytesToHex(link.sk),
            community_id: community.idHex,
            // Store the re-basable form, not `url` (the concrete-origin one
            // handed out today): a synced entry is re-based onto each reader's
            // own share origin, and a stored http(s) origin would short-circuit
            // that — the pin this fix removes.
            url: storedUrl,
            ...(label ? { label } : {}),
            created_at: Math.floor(Date.now() / 1000),
            ...(expiresAtMs ? { expires_at: Math.floor(expiresAtMs / 1000) } : {}),
          },
        ],
        tombstones: [],
      }).catch(() => {
        toast({
          title: "Invite link created, but not synced",
          description:
            "Its revocation secret didn't reach your relays, so your other devices won't be able to revoke this link.",
          variant: "destructive",
        });
      });

      // The member-facing Registry (swallows its own publish errors; the catch
      // covers a throw before it) and the opt-in announcement: neither gates
      // the link working.
      void publishRegistry([...mine]).catch(() => undefined);
      if (announcement) void publishEvent(announcement).catch(() => undefined);

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
      await publishToAnyRelay(nostr, community.relays, tomb, "No relay accepted the revocation.");

      await updateInviteList({
        entries: [],
        tombstones: [{ token: entry.token, community_id: community.idHex }],
      });

      const mine = new Set(folded?.registriesByCreator.get(user.pubkey) ?? []);
      mine.delete(parsed.linkSigner);
      await publishRegistry([...mine]);
    },
  });

  /**
   * Revoke EVERY invite link of mine for this community, in two halves,
   * because they are two different acts (CORD-05 §5):
   *
   *   - A link whose `signer_sk` is in my Invite List gets a real revocation
   *     tombstone at its bundle coordinate — the URL is dead for everyone,
   *     immediately.
   *   - A registry coordinate of mine WITHOUT a held secret (the kind-13303
   *     Invite List is the ONLY copy of `signer_sk`, so a lost or unsynced
   *     list orphans its links) can never be tombstoned, by anyone. The best
   *     remedy that exists is the one the protocol already uses for stripped
   *     creators: republish my registry (vsk 8) without them, so they stop
   *     counting toward the community's Public flag and vanish from the admin
   *     panel — while a URL already in someone's hands keeps vending its
   *     bundle until the next rekey strands it on a dead epoch.
   *
   * A tombstone that no relay accepts keeps its Invite List entry (so the
   * link stays individually revocable on a retry) and stays IN the registry —
   * delisting a still-working held link would flip the Public flag to a lie
   * the creator can still fix.
   */
  const revokeAllMyLinks = useMutation<
    { revoked: number; delisted: number; failed: number },
    Error,
    void
  >({
    mutationFn: async () => {
      if (!user || !community) throw new Error("Not ready.");
      const entries = (inviteList.data?.entries ?? []).filter(
        (e) => e.community_id === community.idHex,
      );

      // Tombstone what this account can (best-effort per link).
      const results = await Promise.allSettled(
        entries.map((entry) =>
          publishToAnyRelay(
            nostr,
            community.relays,
            buildRevocationEvent(hexToBytes(entry.signer_sk)),
            "No relay accepted the revocation.",
          ),
        ),
      );
      const revoked = entries.filter((_, i) => results[i].status === "fulfilled");
      const kept = entries.filter((_, i) => results[i].status === "rejected");

      if (revoked.length > 0) {
        await updateInviteList({
          entries: [],
          tombstones: revoked.map((e) => ({ token: e.token, community_id: community.idHex })),
        });
      }

      // My registry keeps only the links whose tombstone didn't land; every
      // other coordinate of mine — revoked or orphaned — is delisted.
      const mine = new Set(folded?.registriesByCreator.get(user.pubkey) ?? []);
      const keptSigners = new Set(
        kept.map((e) => parseInviteLink(e.url)?.linkSigner).filter((s): s is string => !!s),
      );
      const delisted = [...mine].filter((s) => !keptSigners.has(s)).length;
      await publishRegistry([...mine].filter((s) => keptSigners.has(s)));

      return { revoked: revoked.length, delisted, failed: kept.length };
    },
  });

  /**
   * Whether revoking ALL my links would empty the aggregate live-link set,
   * flipping the community Private — the bulk analogue of
   * {@link revokeWouldPrivatize}.
   */
  const revokeAllWouldPrivatize = (): boolean => {
    if (!user || !folded || folded.liveInviteLinks.size === 0) return false;
    const mine = new Set(folded.registriesByCreator.get(user.pubkey) ?? []);
    return [...folded.liveInviteLinks].every((s) => mine.has(s));
  };

  /**
   * Hand the keys straight to an npub (CORD-05 §6): the same §1 bundle, sealed
   * by the sender's REAL key (the seal's verified npub is what proves who
   * invited them) inside an ephemeral, `k`-tagged giftwrap the recipient can
   * look up indexed. No coordinate, no token, no Registry entry — a Direct
   * Invite never flips the community Public, which is what lets a Private
   * community grow one npub at a time. Unrevocable once landed.
   */
  const sendDirectInvite = useMutation<
    void,
    Error,
    {
      recipientPubkey: string;
      expiresAtMs?: number;
      onlyChannelIdHexes?: ReadonlySet<string>;
      /**
       * Judge entitlement with a Grant this client just published overlaid —
       * the control fold lags its own publish, so a grant-driven vend would
       * otherwise find the recipient still unentitled and hand over nothing.
       */
      entitlementOverlay?: { withRoleIds?: string[]; withoutRoleIds?: string[] };
    }
  >({
    mutationFn: async ({ recipientPubkey, expiresAtMs, onlyChannelIdHexes, entitlementOverlay }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (!user.signer.nip44) throw new Error("This signer can't send direct invites (NIP-44 unsupported).");

      // The recipient is a known npub, so the bundle carries exactly the
      // Private Channels they are a granted role-holder of (CORD-03 §1).
      const bundle = buildBundle(
        {
          kind: "member",
          roster: folded?.roster,
          ownerHex: folded?.ownerHex ?? community.owner,
          memberHex: recipientPubkey,
          overlay: entitlementOverlay,
        },
        { expiresAtMs, onlyChannelIdHexes },
      );
      const rumor = buildDirectInviteRumor(bundle, user.pubkey);
      const seal = await sealDirectInvite(rumor, recipientPubkey, user.signer);
      const wrap = wrapDirectInvite(seal, recipientPubkey, { expiresAtMs });

      // Deliver to the recipient's giftwrap inbox (their 10050 DM relays, else
      // NIP-65 reads), or the stock interop floor when they've published
      // neither — the same set their own scanner resolves (CORD-05 §6).
      const inbox = await recipientInboxRelays(nostr, recipientPubkey);
      // A FAILED inbox lookup is not "no list": falling back to stock here would
      // silently misdeliver a list-having recipient's invite (and report
      // success). Fail loudly so the user retries once the network settles.
      if (inbox === null) throw new Error("Couldn't reach the network to send the invite. Please try again.");
      const relays = inviteDeliveryRelays(inbox);
      await publishToAnyRelay(nostr, relays, wrap, "No relay accepted the invite.");
    },
  });

  /**
   * This creator's live links for THIS community (from the private list),
   * each re-based onto the origin this build hands links out on. The list is
   * a synced record of what was minted, wherever it was minted: a link created
   * in the desktop shell was stored on its private `app://armada` origin, and
   * it is these entries — not a fresh mint — that "Invite" reuses, the link
   * list copies, and a Discover announcement publishes.
   */
  const myLinks = (inviteList.data?.entries ?? [])
    .filter((e) => e.community_id === community?.idHex)
    .map((e) => {
      const url = shareableInviteUrl(shareOrigin(), e.url);
      return url === e.url ? e : { ...e, url };
    });

  /**
   * Re-post the CURRENT bundle at every live link coordinate I hold for this
   * community (CORD-05 §2). A link's coordinate vends whatever was posted
   * last, so a link minted before the community's metadata (or keys) changed
   * keeps serving the stale preview until its creator refreshes it — this is
   * that refresh, run on the community page (freshness watcher) and when
   * re-sharing a link to Discover.
   *
   * VERSION-FENCED, because the control fold is incremental: a fold can hold
   * an OLDER metadata edition than the coordinate already vends (icon swept
   * in, the banner edition not yet), and a refresh built from it would
   * DOWNGRADE the public preview — this exact path overwrote live
   * banner-carrying bundles in the wild. Every re-posted bundle records the
   * metadata version it previewed (`meta_v`), and a refresh skips any link
   * whose current bundle records a newer one than this fold holds. The
   * metadata entity's eid is the community id itself.
   *
   * Each link's refresh targets the community relays UNIONED with the
   * BOOTSTRAP relays frozen into that link's URL fragment: a resolver reads
   * from the bootstrap set, and a bootstrap relay the refresh never reached
   * keeps vending the old bundle. Best-effort per relay.
   */
  const refreshMyLinks = async (): Promise<void> => {
    if (!community || myLinks.length === 0) return;
    const metaV = Number(folded?.heads.get(community.idHex)?.version ?? 0n);
    const bundle: InviteBundle = { ...buildBundle({ kind: "link" }), meta_v: metaV };
    const now = Math.floor(Date.now() / 1000);
    let accepted = 0;
    let attempted = 0;
    await Promise.allSettled(
      myLinks.map(async (entry) => {
        if (entry.expires_at && entry.expires_at <= now) return; // can't be joined; don't touch
        const parsed = parseInviteLink(entry.url);
        if (!parsed) return;
        // What the coordinate currently vends. Unreachable → refresh anyway
        // (a re-post can't be worse than nothing); revoked → never resurrect.
        try {
          const current = await resolveBundle(nostr, parsed, community.relays);
          const currentMetaV = typeof current.meta_v === "number" ? current.meta_v : 0;
          if (currentMetaV > metaV) return; // our fold is behind — refusing to downgrade
        } catch (e) {
          if (e instanceof InviteError && e.code === "revoked") return;
        }
        const [event] = buildRefreshedBundleEvents(bundle, [entry]);
        if (!event) return;
        attempted++;
        const targets = new Set<string>([...community.relays, ...parsed.bootstrapRelays]);
        const results = await Promise.allSettled(
          [...targets].map((url) => nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) })),
        );
        accepted += results.filter((r) => r.status === "fulfilled").length;
      }),
    );
    // Total rejection is a real failure the caller must hear about — swallow
    // it and every coordinate keeps vending the stale bundle forever.
    if (attempted > 0 && accepted === 0) throw new Error("No relay accepted the refreshed invite bundle.");
  };

  /**
   * Whether revoking this link would empty the aggregate live-link set,
   * flipping the community Private (CORD-05 §2): the caller should warn
   * before crossing that line, since bans start rotating keys past it.
   */
  const revokeWouldPrivatize = (url: string): boolean => {
    const parsed = parseInviteLink(url);
    if (!parsed || !folded || folded.liveInviteLinks.size === 0) return false;
    const remaining = new Set(folded.liveInviteLinks);
    remaining.delete(parsed.linkSigner);
    return remaining.size === 0;
  };

  return {
    createLink: createLink.mutateAsync,
    isCreatingLink: createLink.isPending,
    revokeLink: revokeLink.mutateAsync,
    isRevoking: revokeLink.isPending,
    revokeAllMyLinks: revokeAllMyLinks.mutateAsync,
    isRevokingAll: revokeAllMyLinks.isPending,
    revokeAllWouldPrivatize,
    sendDirectInvite: sendDirectInvite.mutateAsync,
    isSendingInvite: sendDirectInvite.isPending,
    myLinks,
    /** True until the Invite List has loaded — `myLinks` is blind before then. */
    linksLoading: inviteList.isLoading,
    refreshMyLinks,
    /** Whether ANY live public link exists — the community's Public/Private flag. */
    isPublic: (folded?.liveInviteLinks.size ?? 0) > 0,
    revokeWouldPrivatize,
  };
}

/**
 * Honest-client compliance: revoke MY OWN live links when I no longer hold
 * CREATE_INVITE.
 *
 * The Registry fold already stops honoring a stripped creator's links (the
 * community reads Private, CORD-05 §5) — but the BUNDLE keeps vending keys at
 * its coordinate, and only this creator's `signer_sk` can tombstone it. An
 * owner stripping the permission flips the flag; this watcher is the only
 * thing that can close the door. Mirrors banlist self-removal: authority
 * decided, my client complies.
 *
 * The action is destructive and irreversible (a tombstone kills a shared URL),
 * so it fires only on POSITIVE evidence of a strip, never on authority absence:
 * a genuine strip folds a revoke edition at my grant coordinate, while a cold
 * device or a relay gap folds nothing there. Requiring my grant HEAD present
 * (on a settled fold) distinguishes "demoted" from "not yet synced."
 */
/**
 * Self-healing link freshness: while a link creator is on their community
 * page, re-post the CURRENT bundle at each of their live link coordinates
 * (once per community per session; a failure retries on a later mount).
 *
 * Unconditional by design. A staleness check would have to ask what the
 * relays vend — but resolveBundle answers through the persisted newest-copy
 * floor, which HIDES relay staleness exactly when it matters (the floor is
 * fresh, the laggard relay is not, and a non-member reading that relay sees
 * the old preview). Rather than build a floor-bypassing probe of every relay,
 * just re-post: the write is one addressable event to a handful of relays,
 * replaces itself, and converges every copy to the current community.
 */
export function useLinkFreshnessWatch(community: Community | undefined): void {
  const { user } = useCurrentUser();
  const control = useControlFold(community);
  const folded = control.data;
  const { myLinks, refreshMyLinks } = useInviteActions(community);
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    if (!user || !community || !folded || myLinks.length === 0) return;
    if (control.isLoading || control.isFetching) return; // don't publish from a partial fold
    // Only a creator still authorized to maintain links should re-post them.
    if (
      user.pubkey !== folded.ownerHex &&
      !isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.CREATE_INVITE)
    ) {
      return;
    }
    if (attempted.current.has(community.idHex)) return;
    attempted.current.add(community.idHex);
    refreshMyLinks().catch(() => {
      attempted.current.delete(community.idHex); // retry on a later mount
    });
  }, [user, community, folded, control.isLoading, control.isFetching, myLinks, refreshMyLinks]);
}

export function useLinkAuthorityWatch(community: Community | undefined): void {
  const { user } = useCurrentUser();
  const control = useControlFold(community);
  const folded = control.data;
  const { myLinks, revokeLink } = useInviteActions(community);
  // Guards only the in-flight revoke per link; a failure retries on the next
  // fold/list change.
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (!user || !community || !folded || myLinks.length === 0) return;
    if (control.isLoading || control.isFetching) return; // an in-flight fold under-authorizes
    if (user.pubkey === folded.ownerHex) return; // the owner is always authorized
    if (isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.CREATE_INVITE)) return;
    // Positive-evidence gate: my grant must actually be in the fold (a strip
    // folds a revoke edition here; a sync gap folds nothing). Without it, a
    // partial fold's authority-absence would wrongly tombstone live links.
    if (!folded.heads.has(bytesToHex(grantLocator(community.id, hex32(user.pubkey))))) return;
    for (const entry of myLinks) {
      if (handled.current.has(entry.token)) continue;
      handled.current.add(entry.token);
      revokeLink({ url: entry.url }).catch(() => {
        handled.current.delete(entry.token);
      });
    }
  }, [user, community, folded, control.isLoading, control.isFetching, myLinks, revokeLink]);
}

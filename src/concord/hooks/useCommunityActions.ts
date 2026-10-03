import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { removeCommunityLocally, useCommunityEntry, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { useControlFold, citationFor, invalidateControl, markDissolvedLocally, probeCommunityDissolved, publishEdition } from "@/concord/hooks/useControlPlane";
import { useGuestbookPublisher } from "@/concord/hooks/useGuestbook";
import { attemptGuestbookJoin, forgetGuestbookJoin, queueGuestbookJoin } from "@/concord/lib/pendingGuestbookJoin";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { verifyEventOnce } from "@/lib/verifyCache";
import { preferPortableRelays, unusableRelaysReason } from "@/lib/relayUsability";
import { channelKeysToWire, isLive, nextChannelEpoch, toJoinMaterial, rehydrateCommunity, type CommunityListEntry, type JoinMaterial } from "@/concord/lib/communityList";
import { mintCommunity } from "@/concord/lib/community";
import { DEFAULT_MESSAGE_EXPIRATION_SECS } from "@/concord/lib/disappearing";
import { accessRolePosition, isAuthorized, MAX_ROLES_PER_COMMUNITY, Permissions } from "@/concord/lib/roles";
import { channelEpochFloor, channelRekeyAddressWindow } from "@/concord/lib/rekey";
import {
  buildChannelEdition,
  buildMetadataEdition,
  buildRoleEdition,
  sealDissolved,
} from "@/concord/lib/control";
import { bytesToHex, hex32, random32 } from "@/concord/lib/derive";
import {
  encodeFragment,
  InviteError,
  parseBundleEvent,
  parseInviteLink,
  STOCK_RELAYS,
  type InviteBundle,
  type ParsedInviteLink,
} from "@/concord/lib/invite";
import { KIND_INVITE_BUNDLE, VSK_INVITE_REVOKED } from "@/concord/lib/kinds";
import {
  claimPendingJoinRun,
  releasePendingJoinRun,
  forgetPendingJoin,
  hasPendingJoin,
  hydratePendingJoins,
  pendingJoinEntriesFor,
  pendingJoinEntry,
  persistPendingJoin,
  recordPendingJoinFailure,
  takeExpiredPendingJoins,
} from "@/concord/lib/pendingJoins";
import { toast } from "@/hooks/useToast";
import { logSync } from "@/lib/syncLog";
import { ownAvServers } from "@/concord/hooks/useVoice";
import { canonicalOrigin } from "@/concord/lib/voice";
import {
  capRelays,
  channelGitRepositoryAttachments,
  MAX_COMMUNITY_AV_BROKERS,
  NAME_MAX_BYTES,
  utf8Len,
  withChannelGitRepositoryAttachments,
  type ChannelMetadata,
  type ChannelView,
  type Community,
  type ImagePointer,
  type PrivateChannelKey,
} from "@/concord/lib/types";
import { withChannelCategory } from "@/concord/lib/channelCategory";
import { channelPosition, compareChannelOrder, reorderPositions, withChannelPosition } from "@/concord/lib/channelOrder";
import { withChannelView } from "@/concord/lib/channelView";
import { controlGroups, foldControlState, openControlWraps } from "@/concord/lib/control";
import { registerStreamKeys } from "@/concord/lib/streamAuth";

/** Bound on the speculative rekey-address scan when privatising (one REQ per held root). */
const MAX_PROBED_CHANNEL_EPOCH = 64;
import { KIND_WRAP } from "@/concord/lib/kinds";
import { attachGitRepository, detachGitRepository, parseGitRepositoryAddress } from "@/lib/gitActivity";

import type { NostrEvent } from "@nostrify/nostrify";

export class BannedFromCommunityError extends Error {
  constructor() {
    super("You're banned from this community and can't rejoin.");
    this.name = "BannedFromCommunityError";
  }
}

export class DissolvedCommunityError extends Error {
  constructor() {
    super("This community was dissolved by its owner and can no longer be joined.");
    this.name = "DissolvedCommunityError";
  }
}

/**
 * Refuse an invite to a dissolved community (CORD-02 §9): bundles keep
 * resolving after dissolution. Applies to direct invites too. The probe
 * caches recent "not found", so preview + join pay once.
 */
export async function assertNotDissolved(
  nostr: Parameters<typeof probeCommunityDissolved>[0],
  bundle: Pick<InviteBundle, "community_id" | "owner" | "relays">,
): Promise<void> {
  const grave = await probeCommunityDissolved(nostr, {
    communityId: bundle.community_id,
    owner: bundle.owner,
    relays: Array.isArray(bundle.relays) ? bundle.relays : [],
  });
  if (grave !== undefined) throw new DissolvedCommunityError();
}

/** Thrown when none of a community's relays is usable on this platform (#47). */
export class UnusableRelaysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableRelaysError";
  }
}

/**
 * Whether a join failure is a VERDICT (asking again gives the same answer)
 * rather than a network failure. Only verdicts drop a pending join; others
 * retry until `PENDING_JOIN_MAX_AGE_MS` / `PENDING_JOIN_MAX_ATTEMPTS`.
 */
export function isJoinRejected(error: unknown): boolean {
  return (
    error instanceof BannedFromCommunityError ||
    error instanceof DissolvedCommunityError ||
    error instanceof UnusableRelaysError ||
    error instanceof InviteError
  );
}

function toastJoinAbandoned(name: string): void {
  toast({
    title: `Couldn't join ${name}`,
    description: "Armada stopped retrying. Ask for a new invite to try again.",
    variant: "destructive",
  });
}

/** Thrown when the control plane can't be read to verify access (retryable). */
export class ControlUnreadableError extends Error {
  constructor() {
    super("Couldn't verify your access to this community. Please try again.");
    this.name = "ControlUnreadableError";
  }
}

/**
 * Refuse to join when the CURRENT Banlist names me (CORD-04 §4), before any
 * side effect. Fail CLOSED: a real community always has control editions, so
 * an empty read means withheld/unreachable, not "no ban". NIP-42 authenticated
 * with the control-group keys.
 *
 * ORDERING INVARIANT: fold the FRESH single-epoch bundle entry, before any
 * merge with a held entry (a merged entry would need cross-epoch snapshot
 * attribution; see headCandidates).
 */
export async function assertNotBanned(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  pubkey: string,
): Promise<void> {
  // Enforce the single-epoch invariant: a multi-epoch entry could anchor on a
  // stale fragment and let a banned rejoiner through.
  if (community.heldRoots.length !== 1) throw new ControlUnreadableError();
  const groups = controlGroups(community);
  // Otherwise a gated relay serves nothing and the ban goes unseen.
  registerStreamKeys(groups, community.relays);
  const authors = groups.map((g) => g.pk);
  const results = await Promise.all(
    community.relays.map((url) =>
      nostr
        .relay(url)
        .query([{ kinds: [KIND_WRAP], authors }], { signal: AbortSignal.timeout(12_000) })
        .catch(() => [] as NostrEvent[]),
    ),
  );
  const seen = new Set<string>();
  const wraps = results.flat().filter((e) => (seen.has(e.id) ? false : seen.add(e.id)));
  if (wraps.length === 0) throw new ControlUnreadableError();
  const folded = foldControlState(openControlWraps(wraps, groups), community.id, community.owner);
  if (folded.banned.has(pubkey)) throw new BannedFromCommunityError();
}

export interface InvitePreview {
  communityId: string;
  name: string;
  channelCount: number;
  relays: string[];
  bundle: InviteBundle;
}

/**
 * Newest bundle event per link coordinate, persisted in KV so a laggard relay's
 * older copy can't regress a later resolve (newest-wins; tombstones stay
 * terminal). Only signature-verified events enter, so forgeries can't pin it.
 */
const BUNDLE_FLOOR_KV = "c2bundlehead:";
const newestBundleEvents = new Map<string, NostrEvent>();

async function readBundleFloor(linkSigner: string): Promise<NostrEvent | undefined> {
  const mem = newestBundleEvents.get(linkSigner);
  if (mem) return mem;
  try {
    const stored = await getArmadaDB().kv.get<NostrEvent>(BUNDLE_FLOOR_KV + linkSigner);
    if (stored) newestBundleEvents.set(linkSigner, stored);
    return stored;
  } catch {
    return undefined;
  }
}

function writeBundleFloor(linkSigner: string, event: NostrEvent): void {
  newestBundleEvents.set(linkSigner, event);
  // Best-effort: losing the floor only re-exposes the relay race.
  getArmadaDB().kv.set(BUNDLE_FLOOR_KV + linkSigner, event).catch(() => undefined);
}

/**
 * Wait for remaining relays after the first valid bundle arrives; a dead relay
 * mustn't hold previews hostage. Stale risk is covered by the floor and the
 * home-relay second hop.
 */
const BUNDLE_GRACE_MS = 250;
const BUNDLE_RELAY_TIMEOUT_MS = 8000;

async function queryBundleCoordinate(
  nostr: ReturnType<typeof useNostr>["nostr"],
  invite: ParsedInviteLink,
  relays: string[],
): Promise<NostrEvent[]> {
  const valid: NostrEvent[] = [];
  await new Promise<void>((resolve) => {
    if (relays.length === 0) return resolve();
    let settled = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(graceTimer);
      resolve();
    };
    for (const url of relays) {
      nostr
        .relay(url)
        .query(
          [{ kinds: [KIND_INVITE_BUNDLE], authors: [invite.linkSigner], "#d": [""], limit: 1 }],
          { signal: AbortSignal.timeout(BUNDLE_RELAY_TIMEOUT_MS) },
        )
        .then((events) => {
          // Only link-signer-authored, signature-valid events, or a forged far-future
          // event would poison the floor before parseBundleEvent rejects it.
          for (const e of events) {
            if (
              e.kind === KIND_INVITE_BUNDLE &&
              e.pubkey === invite.linkSigner &&
              verifyEventOnce(e)
            ) {
              valid.push(e);
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          settled += 1;
          if (settled === relays.length) finish();
          else if (valid.length > 0 && graceTimer === undefined) {
            graceTimer = setTimeout(finish, BUNDLE_GRACE_MS);
          }
        });
    }
  });
  return valid.sort((a, b) => b.created_at - a.created_at);
}

/** Result of resolveBundle's non-blocking home-relay second hop. */
export interface SecondHopResult {
  bundle?: InviteBundle;
  revoked?: boolean;
}

export async function resolveBundle(
  nostr: ReturnType<typeof useNostr>["nostr"],
  invite: ParsedInviteLink,
  fallbackRelays: string[],
  opts?: {
    /**
     * Run the home-relay second hop in the BACKGROUND and report here (for
     * previews; a join re-resolves blocking). The floor is written either way.
     */
    onSecondHop?: (result: SecondHopResult) => void;
  },
): Promise<InviteBundle> {
  const pool = invite.bootstrapRelays.length ? invite.bootstrapRelays : fallbackRelays;
  const flat = await queryBundleCoordinate(nostr, invite, pool);
  // The persisted floor keeps a flaky read from un-replacing what a better read saw.
  const remembered = await readBundleFloor(invite.linkSigner);
  let best = flat[0] as NostrEvent | undefined;
  if (remembered && (!best || remembered.created_at > best.created_at)) best = remembered;
  if (!best) throw new Error("Couldn't find that invite on its relays.");

  let bundle = parseBundleEvent(best, invite.linkSigner, invite.token, Date.now());

  // Second hop: refreshes always land on the community's HOME relays, even if a
  // bootstrap relay missed it; otherwise stale previews (and keys) could persist.
  const covered = new Set(pool);
  const home = (Array.isArray(bundle.relays) ? bundle.relays : []).filter((r) => !covered.has(r));

  if (home.length > 0 && opts?.onSecondHop) {
    const onSecondHop = opts.onSecondHop;
    // Write the first-hop floor NOW; the background hop only overwrites with strictly newer.
    if (best !== remembered) writeBundleFloor(invite.linkSigner, best);
    const first = best;
    void (async () => {
      const [newer] = await queryBundleCoordinate(nostr, invite, home).catch(() => [] as NostrEvent[]);
      if (!newer || newer.created_at <= first.created_at) return;
      try {
        const fresher = parseBundleEvent(newer, invite.linkSigner, invite.token, Date.now());
        writeBundleFloor(invite.linkSigner, newer);
        onSecondHop({ bundle: fresher });
      } catch {
        // A newer tombstone terminates; other malformed events keep the first-hop
        // bundle and floor (a floor that doesn't parse would poison later reads).
        if (newer.tags.some((t) => t[0] === "vsk" && t[1] === VSK_INVITE_REVOKED)) {
          writeBundleFloor(invite.linkSigner, newer);
          onSecondHop({ revoked: true });
        }
      }
    })().catch(() => undefined); // the refinement is best-effort
    return bundle;
  }

  if (home.length > 0) {
    const [newer] = await queryBundleCoordinate(nostr, invite, home).catch(() => [] as NostrEvent[]);
    if (newer && newer.created_at > best.created_at) {
      try {
        bundle = parseBundleEvent(newer, invite.linkSigner, invite.token, Date.now());
        best = newer;
      } catch {
        // A newer tombstone terminates; other malformed events keep the first-hop bundle.
        if (newer.tags.some((t) => t[0] === "vsk" && t[1] === VSK_INVITE_REVOKED)) throw new InviteError("revoked", "this invite link has been revoked");
      }
    }
  }

  if (best !== remembered) writeBundleFloor(invite.linkSigner, best);
  return bundle;
}

/**
 * The bundle from the persisted floor, no network. `null` means "ask the
 * network", never "not revoked". Used for instant previews.
 */
export async function readCachedBundle(invite: ParsedInviteLink): Promise<InviteBundle | null> {
  const remembered = await readBundleFloor(invite.linkSigner);
  if (!remembered) return null;
  try {
    return parseBundleEvent(remembered, invite.linkSigner, invite.token, Date.now());
  } catch {
    return null;
  }
}

export function bundleToEntry(bundle: InviteBundle, opts?: { inviteRef?: string }): CommunityListEntry {
  const jm: JoinMaterial = {
    community_id: bundle.community_id,
    owner: bundle.owner,
    owner_salt: bundle.owner_salt,
    community_root: bundle.community_root,
    root_epoch: bundle.root_epoch,
    // The split epoch's Control address (CORD-02 §7); absent = legacy.
    ...(typeof bundle.control_pk === "string" && /^[0-9a-f]{64}$/i.test(bundle.control_pk)
      ? { control_pk: bundle.control_pk.toLowerCase() }
      : {}),
    channels: Array.isArray(bundle.channels)
      ? bundle.channels.map((ch) => ({ id: ch.id, key: ch.key, epoch: ch.epoch, name: ch.name }))
      : [],
    relays: capRelays(bundle.relays),
    name: bundle.name,
  };
  return {
    community_id: jm.community_id,
    seed: jm,
    current: jm,
    added_at: Date.now(),
    // Lets a member stranded on a superseded epoch re-resolve the SAME link (CORD-05 §2, useStrandedRecovery).
    ...(opts?.inviteRef ? { invite_ref: opts.inviteRef } : {}),
  };
}

/** The domain-agnostic bare form of a parsed invite link: `<naddr>#<fragment>`. */
export function inviteRefOf(invite: ParsedInviteLink): string {
  return `${invite.naddr}#${encodeFragment(invite.token, invite.bootstrapRelays)}`;
}

/**
 * Home relays for a NEW community: the configured community relays, else the
 * CORD stock set. Portable-filtered (#47), deduped, capped. App and DM relays
 * are deliberately not included.
 */
export function defaultCreateRelays(communityRelays: string[]): string[] {
  return capRelays(preferPortableRelays(communityRelays.length > 0 ? communityRelays : STOCK_RELAYS));
}

/** The create dialog's preselected relays; synchronous so the list paints on first render. */
export function useCreateRelayCandidates(): string[] {
  const { config } = useAppContext();
  return useMemo(() => defaultCreateRelays(config.communityRelays), [config.communityRelays]);
}

/**
 * Create / preview / join. Genesis is EXACTLY two owner-signed editions
 * (metadata + public `#general`, CORD-02 §1), keys recorded in the Community
 * List, the creator's Guestbook Join, then a private `#private` starter.
 */
export function useCommunityActions() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const queryClient = useQueryClient();

  // For fragments with no bootstrap relays: the user's app relays, else the stock interop set.
  const bootstrapRelays = config.appRelays.length > 0 ? config.appRelays : STOCK_RELAYS;

  const create = useMutation<
    { communityId: string; name: string },
    Error,
    {
      name: string;
      relays?: string[];
      /** The community's voice servers (CORD-02 §6); omitted = the creator's own. */
      avBrokers?: string[];
      messageExpirationSecs?: number;
      /** Optional genesis presentation (CORD-02 §6), from the creation wizard. */
      description?: string;
      icon?: ImagePointer;
      banner?: ImagePointer;
    }
  >({
    mutationFn: async ({ name, relays: chosen, avBrokers: chosenBrokers, messageExpirationSecs, description, icon, banner }) => {
      if (!user) throw new Error("Sign in to start an encrypted community.");
      if (!user.signer.nip44) throw new Error("This signer can't hold encrypted communities (NIP-44 unsupported).");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Name your community first.");

      // Prefer wss://: a ws:// relay sealed into the bundle is unreachable from secure origins (#47).
      const relays = chosen && chosen.length > 0
        ? preferPortableRelays(chosen)
        : defaultCreateRelays(config.communityRelays);
      const { community, generalChannelId } = mintCommunity(trimmed, user.pubkey, relays);

      // CORD-08: default 30 days; 0 (off) writes no field.
      const timerSecs = Math.floor(messageExpirationSecs ?? DEFAULT_MESSAGE_EXPIRATION_SECS);

      // In the genesis edition so first-time folders see the face, and an abandoned
      // follow-up can't leave version 1 wrong.
      const trimmedDescription = description?.trim();

      // Members resolve calls from this list (CORD-07 §5), so an explicit EMPTY list is meaningful.
      const avBrokers = (chosenBrokers ?? ownAvServers())
        .map(canonicalOrigin)
        .filter((origin): origin is string => Boolean(origin))
        .slice(0, MAX_COMMUNITY_AV_BROKERS);

      // Genesis: two owner-signed editions, nothing more (CORD-02 §1).
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildMetadataEdition(
          community.id,
          {
            name: trimmed,
            relays: community.relays,
            ...(avBrokers.length > 0 ? { av_brokers: avBrokers } : {}),
            ...(trimmedDescription ? { description: trimmedDescription } : {}),
            ...(icon ? { icon } : {}),
            ...(banner ? { banner } : {}),
            ...(timerSecs > 0 ? { message_expiration: timerSecs } : {}),
          },
          { actorPubkey: user.pubkey, version: 1n },
        ),
      );
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          generalChannelId,
          { name: "general", private: false },
          { actorPubkey: user.pubkey, version: 1n },
        ),
      );

      // Private channel key goes into the vault BEFORE its edition publishes, or a
      // lost list write orphans the only copy of the key.
      const privateStarter: PrivateChannelKey = { id: random32(), key: random32(), epoch: 0n, name: "private" };
      community.privateChannels = [privateStarter];

      // Record membership FIRST (the vault), then announce presence.
      const jm = toJoinMaterial(community, { relays: community.relays });
      await updateList({
        type: "add",
        entry: { community_id: community.idHex, seed: jm, current: jm, added_at: Date.now() },
      });

      // Role then channel (createChannel ordering). Best-effort past here: genesis
      // landed, so failing would strand a working community and invite a duplicate;
      // roll the key back and ship #general alone.
      try {
        // The owner's rank needs no fold (community_id commitment), so this can't throw for the creator.
        const position = accessRolePosition(undefined, user.pubkey, community.owner);
        if (position === undefined) throw new Error("No resolvable rank for the access role.");
        await publishEdition(
          nostr,
          community,
          user.signer,
          buildRoleEdition(
            {
              roleId: bytesToHex(random32()),
              name: "private",
              position,
              permissions: 0n,
              scope: { kind: "channel", channelId: bytesToHex(privateStarter.id) },
              color: 0,
            },
            { actorPubkey: user.pubkey, version: 1n },
          ),
        );
        await publishEdition(
          nostr,
          community,
          user.signer,
          buildChannelEdition(
            privateStarter.id,
            { name: "private", private: true },
            { actorPubkey: user.pubkey, version: 1n },
          ),
        );
      } catch {
        community.privateChannels = [];
        await updateList({
          type: "refresh-channels",
          communityId: community.idHex,
          channels: channelKeysToWire([]),
        }).catch(() => undefined);
      }

      queueGuestbookJoin({ viewer: user.pubkey, communityIdHex: community.idHex, ms: Date.now() });
      void attemptGuestbookJoin(nostr, community, user.signer, user.pubkey);

      return { communityId: community.idHex, name: trimmed };
    },
  });

  const preview = useMutation<InvitePreview, Error, { invite: ParsedInviteLink }>({
    mutationFn: async ({ invite }) => {
      const bundle = await resolveBundle(nostr, invite, bootstrapRelays);
      // Fail loudly if no relay is reachable here (#47), e.g. ws:// under mixed-content blocking.
      const unusable = unusableRelaysReason(bundle.relays);
      if (unusable) throw new Error(unusable);
      await assertNotDissolved(nostr, bundle);
      return {
        communityId: bundle.community_id,
        name: bundle.name,
        channelCount: Array.isArray(bundle.channels) ? bundle.channels.length : 0,
        relays: bundle.relays,
        bundle,
      };
    },
  });

  // Durable join chain, in order: fresh resolve (catches revocations), reachability,
  // ban check BEFORE any record/publish, vault write, best-effort Guestbook Join.
  // `pendingId` names the pending join; one walked away from isn't written.
  const completeJoin = async (
    invite: ParsedInviteLink,
    pendingId?: string,
  ): Promise<{ communityId: string; name: string }> => {
      if (!user) throw new Error("Sign in to join an encrypted community.");
      const bundle = await resolveBundle(nostr, invite, bootstrapRelays);
      const unusable = unusableRelaysReason(bundle.relays);
      if (unusable) throw new UnusableRelaysError(unusable);
      // Also here: the optimistic path may join from a pre-grave preview bundle.
      await assertNotDissolved(nostr, bundle);
      const entry = bundleToEntry(bundle, { inviteRef: inviteRefOf(invite) });
      // CORD-04 §4: check before recording or publishing anything.
      const community = rehydrateCommunity(entry);
      if (community) await assertNotBanned(nostr, community, user.pubkey);
      const walkedAway = () => pendingId !== undefined && !hasPendingJoin(user.pubkey, pendingId);
      if (walkedAway()) return { communityId: bundle.community_id, name: bundle.name };
      // Date by the CLICK, not this (possibly resumed) run, so a replay can't
      // outrank a later Leave or kick.
      const clicked = pendingId !== undefined ? pendingJoinEntry(user.pubkey, pendingId)?.added_at : undefined;
      if (clicked !== undefined) entry.added_at = clicked;
      const list = await updateList({ type: "add", entry, replay: pendingId !== undefined });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
      if (!isLive(list, bundle.community_id)) return { communityId: bundle.community_id, name: bundle.name };

      // Guestbook Join (CORD-02 §5 / CORD-05 §1), recorded before the signer is
      // asked so a signer or relay that fails it is retried (`pendingGuestbookJoin`),
      // not dropped. A Leave forgets the record, so it never goes out after one.
      if (community && !walkedAway()) {
        const attribution = bundle.creator_npub
          ? { creator: bundle.creator_npub, label: bundle.label }
          : undefined;
        queueGuestbookJoin({ viewer: user.pubkey, communityIdHex: community.idHex, ms: entry.added_at, attribution });
        void attemptGuestbookJoin(nostr, community, user.signer, user.pubkey);
      }

      return { communityId: bundle.community_id, name: bundle.name };
  };

  /**
   * Run a pending join's chain and settle the record: forgotten on success or
   * refusal, KEPT (and counted) on transient failure. `resumed` retries stay quiet.
   */
  const settleJoin = (
    invite: ParsedInviteLink,
    communityId: string,
    name: string,
    resumed = false,
  ): void => {
    if (!user) return;
    const pubkey = user.pubkey;
    claimPendingJoinRun(pubkey, communityId);
    void completeJoin(invite, communityId)
      .then(() => forgetPendingJoin(pubkey, communityId))
      .catch(async (e) => {
        const rejected = isJoinRejected(e);
        const gaveUp = !rejected && (await recordPendingJoinFailure(pubkey, communityId));
        // Transient (a signer still awaiting approval, slow relays): this session may retry.
        if (!rejected && !gaveUp) releasePendingJoinRun(pubkey, communityId);
        logSync(
          "list2",
          `pending join ${communityId.slice(0, 8)} ${rejected ? "refused" : gaveUp ? "failed, given up on" : "failed, kept for retry"}: ${e instanceof Error ? e.message : String(e)}`,
        );
        if (gaveUp) return toastJoinAbandoned(name);
        if (rejected) void forgetPendingJoin(pubkey, communityId);
        else if (resumed) return;
        toast({
          title:
            e instanceof BannedFromCommunityError
              ? "You're banned"
              : e instanceof DissolvedCommunityError
                ? `${name} was dissolved`
                : rejected
                  ? `Couldn't join ${name}`
                  : `Couldn't finish joining ${name}`,
          description: rejected
            ? (e instanceof Error ? e.message : "The invite didn't work.")
            : "Armada will try again the next time it starts.",
          ...(rejected ? { variant: "destructive" as const } : {}),
        });
      });
  };

  const join = useMutation<
    { communityId: string; name: string },
    Error,
    { invite: ParsedInviteLink; bundle?: InviteBundle }
  >({
    mutationFn: async ({ invite, bundle: resolved }) => {
      if (!user) throw new Error("Sign in to join an encrypted community.");
      if (!resolved) return completeJoin(invite);

      // Optimistic path: record a pending entry on disk and answer NOW; the durable
      // chain (with the ban check before any publish) runs behind it.
      const unusable = unusableRelaysReason(resolved.relays);
      if (unusable) throw new UnusableRelaysError(unusable);
      await persistPendingJoin(user.pubkey, bundleToEntry(resolved, { inviteRef: inviteRefOf(invite) }));
      const { community_id: communityId, name } = resolved;
      settleJoin(invite, communityId, name);
      return { communityId, name };
    },
  });

  return {
    settleJoin,
    create: create.mutateAsync,
    isCreating: create.isPending,
    preview: preview.mutateAsync,
    isPreviewing: preview.isPending,
    join: join.mutateAsync,
    isJoining: join.isPending,
  };
}

/** How often an in-session failed pending join is tried again. */
const PENDING_JOIN_RETRY_MS = 2 * 60_000;

/** Resume pending joins from a previous launch (pendingJoins.ts), and retry this session's failed ones. */
export function useResumePendingJoins(): void {
  const { user } = useCurrentUser();
  const { settleJoin } = useCommunityActions();
  const settleRef = useRef(settleJoin);
  settleRef.current = settleJoin;
  const pubkey = user?.pubkey;
  const canWrite = Boolean(user?.signer.nip44);

  useEffect(() => {
    if (!pubkey || !canWrite) return;
    let cancelled = false;
    const resume = () =>
      void hydratePendingJoins(pubkey).then(() => {
        if (cancelled) return;
        for (const entry of takeExpiredPendingJoins(pubkey)) {
          logSync("list2", `pending join ${entry.community_id.slice(0, 8)} past its retry bound, given up on`);
          toastJoinAbandoned(entry.current.name);
        }
        for (const entry of pendingJoinEntriesFor(pubkey)) {
          if (!claimPendingJoinRun(pubkey, entry.community_id)) continue;
          const invite = typeof entry.invite_ref === "string" ? parseInviteLink(entry.invite_ref) : undefined;
          if (!invite) {
            void forgetPendingJoin(pubkey, entry.community_id);
            continue;
          }
          settleRef.current(invite, entry.community_id, entry.current.name, true);
        }
      });
    resume();
    // A chain that failed this session (a signer awaiting approval) is retried
    // when the user comes back — likely from approving it — and on a slow timer.
    const onVisible = () => {
      if (document.visibilityState === "visible") resume();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(resume, PENDING_JOIN_RETRY_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [pubkey, canWrite]);
}

export function useCommunityManagement(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const { data: folded } = useControlFold(community);
  const publisher = useGuestbookPublisher(community);
  const entry = useCommunityEntry(community?.idHex);
  const queryClient = useQueryClient();
  const removeRailKey = useRemoveRailKey();

  const leave = useMutation<void, Error, void>({
    // Local-only; `navigator.onLine` is unreliable in the Android WebView.
    networkMode: "always",
    mutationFn: async () => {
      if (!user || !community) throw new Error("Not ready.");
      const communityId = community.idHex;
      const removedAt = Date.now();
      // The local tombstone is authoritative and on disk now. Walk away from any
      // pending join too, or its chain would re-add membership.
      await forgetPendingJoin(user.pubkey, communityId);
      forgetGuestbookJoin(user.pubkey, communityId);
      await removeCommunityLocally(queryClient, user.pubkey, communityId, removedAt);
      // Follows the local leave so a rejoin doesn't land back in the old folder.
      removeRailKey(`c2:${communityId}`);
      // Guestbook Leave and vault write run in the background (either can take a
      // long time); the outbox and next sync's reconcile retry them.
      void publisher.mutateAsync({ type: "leave" }).catch(() => undefined);
      void updateList({ type: "remove", communityId, removedAt }).catch((e) => {
        logSync(
          "list2",
          `leave ${communityId.slice(0, 8)}: vault write failed (${e instanceof Error ? e.message : String(e)}) — left locally, the next sync republishes it`,
        );
      });
    },
  });

  const dissolve = useMutation<void, Error, { retire?: () => Promise<void> } | void>({
    mutationFn: async (opts) => {
      if (!user || !community) throw new Error("Not ready.");
      if (user.pubkey !== community.owner) throw new Error("Only the owner can dissolve the community.");
      const wrap = await sealDissolved(community.id, user.pubkey, user.signer);
      const results = await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error("No relay accepted the dissolution.");
      }
      // Mark dissolved BEFORE dropping the vault entry: `useCallSync` treats a gone
      // entry as removal, but a known grave keeps the call connected.
      await markDissolvedLocally(queryClient, community.idHex, Date.now());
      // Retire links/listings only after the grave is accepted. Tombstones and
      // NIP-09 only: nothing may follow the grave on the control plane. Misses are offered as Retry.
      await opts?.retire?.().catch(() => undefined);
      await updateList({ type: "remove", communityId: community.idHex });
    },
  });

  /**
   * Mint a Role scoped to a Private Channel (CORD-04 §2 `scope`); the name is
   * display only. NO permission bits (access is key possession, §1), and minted
   * at the BOTTOM so grantees aren't promoted (see `accessRolePosition`).
   */
  const mintChannelRole = async (channelId: Uint8Array, roleName: string): Promise<string | undefined> => {
    if (!user || !community) return undefined;
    const ownerHex = folded?.ownerHex ?? community.owner;
    // A signer with no resolvable rank may mint no Role (verifiers would drop it as self-promotion).
    const position = accessRolePosition(folded?.roster, user.pubkey, ownerHex);
    if (position === undefined) {
      throw new Error("You don't hold a rank that can create this channel's access role.");
    }
    // At the 100-role cap the fold keeps the lowest role_ids (CORD-04 §2), so a
    // new id could fold out or evict another; refuse.
    if ((folded?.roster.roles.length ?? 0) >= MAX_ROLES_PER_COMMUNITY) {
      throw new Error("This community is at its 100-role limit; delete a role first.");
    }
    const roleId = bytesToHex(random32());
    await publishEdition(
      nostr,
      community,
      user.signer,
      buildRoleEdition(
        {
          roleId,
          name: roleName.slice(0, 64),
          position,
          permissions: 0n,
          scope: { kind: "channel", channelId: bytesToHex(channelId) },
          color: 0,
        },
        { actorPubkey: user.pubkey, version: 1n, authority: citationFor(community, folded, user.pubkey) },
      ),
    );
    return roleId;
  };

  /** Mint an ADDITIONAL access Role for a Private Channel (entitlement is any-of); held by nobody until granted. */
  const mintAccessRole = useMutation<string | undefined, Error, { channelIdHex: string; name: string }>({
    mutationFn: async ({ channelIdHex, name }) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Role name is required.");
      const roleId = await mintChannelRole(hex32(channelIdHex), trimmed);
      if (community) invalidateControl(queryClient, community.idHex);
      return roleId;
    },
  });

  const createChannel = useMutation<
    { channelIdHex: string; minted?: PrivateChannelKey },
    Error,
    { name: string; repository?: { address: string; relayHints: string[] }; isPrivate?: boolean; accessRoleName?: string; view?: ChannelView }
  >({
    mutationFn: async ({ name, repository, isPrivate, accessRoleName, view }) => {
      if (!user || !community) throw new Error("Not ready.");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Channel name is required.");
      const channelId = random32();
      // In the FIRST edition: attachRepository resolves from the fold, which won't
      // have the new channel yet.
      let metadata: ChannelMetadata = { name: trimmed, private: Boolean(isPrivate) };
      // Same: a forum opens as one from the start.
      if (view) metadata = withChannelView(metadata, view);
      if (repository) {
        const address = parseGitRepositoryAddress(repository.address);
        if (!address) throw new Error("Repository address must be a canonical 30617 coordinate.");
        metadata = withChannelGitRepositoryAttachments(
          metadata,
          attachGitRepository([], address, repository.relayHints, Math.floor(Date.now() / 1000)),
        );
      }

      // CORD-03: an independent key at epoch 0, stored BEFORE the edition
      // publishes (else the only key copy is orphaned); failures roll back below.
      let minted: PrivateChannelKey | undefined;
      const priorChannels = community.privateChannels;
      if (isPrivate) {
        minted = { id: channelId, key: random32(), epoch: 0n, name: trimmed };
        await updateList({
          type: "refresh-channels",
          communityId: community.idHex,
          channels: channelKeysToWire([...priorChannels, minted]),
        });
      }

      try {
        // Role BEFORE the channel edition: an orphan role is inert, while an
        // access-less live channel invites a duplicate retry.
        if (isPrivate) await mintChannelRole(channelId, accessRoleName?.trim() || trimmed);
        await publishEdition(
          nostr,
          community,
          user.signer,
          buildChannelEdition(
            channelId,
            metadata,
            { actorPubkey: user.pubkey, version: 1n, authority: citationFor(community, folded, user.pubkey) },
          ),
        );
      } catch (e) {
        if (minted) {
          // Best-effort: remove the unannounced key so it doesn't ghost in the sidebar.
          await updateList({ type: "refresh-channels", communityId: community.idHex, channels: channelKeysToWire(priorChannels) }).catch(() => undefined);
        }
        throw e;
      }
      invalidateControl(queryClient, community.idHex);
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
      return { channelIdHex: bytesToHex(channelId), minted };
    },
  });

  const renameChannel = useMutation<void, Error, { channelIdHex: string; name: string }>({
    mutationFn: async ({ channelIdHex, name }) => {
      if (!user || !community) throw new Error("Not ready.");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Channel name is required.");
      const def = folded?.channels.get(channelIdHex);
      const head = folded?.heads.get(channelIdHex);
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          // Round-trip untouched metadata (CORD-02 §6).
          { ...(def?.metadata ?? { private: false }), name: trimmed },
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl(queryClient, community.idHex);
    },
  });

  /**
   * Convert Public → Private (CORD-03 §2): mint a key at the next channel
   * epoch (stored before the edition), flip the flag, and mint the scoped
   * Role. Protects the future only: prior history stays readable to all
   * members. `minted` is returned for vending.
   */
  const privatiseChannel = useMutation<
    { minted?: PrivateChannelKey; roleId?: string },
    Error,
    { channelIdHex: string; accessRoleName?: string }
  >({
    mutationFn: async ({ channelIdHex, accessRoleName }) => {
      if (!user || !community) throw new Error("Not ready.");
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found in the control fold yet; try again shortly.");
      if (def.isPrivate) throw new Error("This channel is already private.");
      const head = folded?.heads.get(channelIdHex);

      // CORD-03 §2: mint at the NEXT channel_epoch (never reset, or two keys share
      // an epoch). The floor is read off the wire (CORD-06 §2 addresses are
      // derivable), so unheld generations still count.
      const channelId = hex32(channelIdHex);
      const roots = community.heldRoots.length > 0 ? community.heldRoots : [{ key: community.root }];
      const window = channelRekeyAddressWindow(roots, channelId, MAX_PROBED_CHANNEL_EPOCH);
      let seenPubkeys: string[] | undefined;
      try {
        const seen = await Promise.all(
          community.relays.map((url) =>
            nostr
              .relay(url)
              .query([{ kinds: [KIND_WRAP], authors: [...window.keys()] }], {
                signal: AbortSignal.timeout(8000),
              })
              .catch(() => []),
          ),
        );
        seenPubkeys = seen.flat().map((e) => e.pubkey);
      } catch {
        // Unreachable relays: the local floor stands alone.
      }
      // A saturated probe THROWS: hitting the window edge proves only the edge, and
      // minting on that guess could collide.
      const observedFloor =
        seenPubkeys === undefined ? 0n : channelEpochFloor(window, seenPubkeys, MAX_PROBED_CHANNEL_EPOCH);

      const priorChannels = community.privateChannels;
      const minted: PrivateChannelKey = {
        id: channelId,
        key: random32(),
        epoch: nextChannelEpoch(priorChannels, channelIdHex, observedFloor),
        name: def.name,
      };
      await updateList({
        type: "refresh-channels",
        communityId: community.idHex,
        channels: channelKeysToWire([...priorChannels, minted]),
      });

      let roleId: string | undefined;
      try {
        // Role first, flag second (createChannel ordering).
        roleId = await mintChannelRole(channelId, accessRoleName?.trim() || def.name);
        await publishEdition(
          nostr,
          community,
          user.signer,
          buildChannelEdition(
            channelId,
            // Round-trip untouched metadata (CORD-02 §6).
            { ...def.metadata, private: true },
            {
              actorPubkey: user.pubkey,
              version: head ? head.version + 1n : 1n,
              prevHash: head?.hash,
              authority: citationFor(community, folded, user.pubkey),
            },
          ),
        );
      } catch (e) {
        await updateList({ type: "refresh-channels", communityId: community.idHex, channels: channelKeysToWire(priorChannels) }).catch(() => undefined);
        throw e;
      }
      invalidateControl(queryClient, community.idHex);
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
      return { minted, roleId };
    },
  });

  /**
   * Convert Private → Public (CORD-03 §2): flip the flag only. The held key
   * stays so the private era remains readable to its holders; the scoped Role
   * is left (inert).
   */
  const publiciseChannel = useMutation<void, Error, { channelIdHex: string }>({
    mutationFn: async ({ channelIdHex }) => {
      if (!user || !community) throw new Error("Not ready.");
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found in the control fold yet; try again shortly.");
      if (!def.isPrivate) throw new Error("This channel is already public.");
      if (def.deleted) throw new Error("This channel was deleted.");
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error("Making a channel public needs the Manage-channels permission.");
      }
      const head = folded?.heads.get(channelIdHex);
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          // Round-trip untouched metadata (CORD-02 §6).
          { ...def.metadata, private: false },
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl(queryClient, community.idHex);
    },
  });

  /** The sidebar's channel order: the shared index space for every reorder. */
  const orderedForMove = useCallback(
    () =>
      [...(folded?.channels.values() ?? [])]
        .filter((c) => !c.deleted)
        .map((c) => ({
          idHex: c.channelIdHex,
          name: c.name,
          position: channelPosition(c.metadata),
        }))
        .sort(compareChannelOrder),
    [folded],
  );

  /**
   * One Channel edition per changed position. The first reorder in a
   * never-ordered community stamps every channel. Partial failures stay coherent.
   */
  const publishPositions = useCallback(
    async (moves: Array<{ idHex: string; position: number }>) => {
      if (!user || !community) throw new Error("Not ready.");
      for (const { idHex, position } of moves) {
        const def = folded?.channels.get(idHex);
        if (!def) continue;
        const head = folded?.heads.get(idHex);
        await publishEdition(
          nostr,
          community,
          user.signer,
          buildChannelEdition(
            hex32(idHex),
            // Round-trip untouched metadata (CORD-02 §6).
            withChannelPosition(def.metadata, position),
            {
              actorPubkey: user.pubkey,
              version: head ? head.version + 1n : 1n,
              prevHash: head?.hash,
              authority: citationFor(community, folded, user.pubkey),
            },
          ),
        );
      }
      invalidateControl(queryClient, community.idHex);
    },
    [user, community, folded, nostr, queryClient],
  );

  /** Apply a drag's arrangement: ONE edition per channel carrying both position and category. */
  const arrangeChannels = useMutation<
    void,
    Error,
    Array<{ idHex: string; position: number; category: string | undefined }>
  >({
    mutationFn: async (changes) => {
      if (!user || !community) throw new Error("Not ready.");
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error("Rearranging channels needs the Manage-channels permission.");
      }
      for (const { idHex, position, category } of changes) {
        const def = folded?.channels.get(idHex);
        if (!def) continue;
        const head = folded?.heads.get(idHex);
        await publishEdition(
          nostr,
          community,
          user.signer,
          buildChannelEdition(
            hex32(idHex),
            // Round-trip untouched metadata (CORD-02 §6).
            withChannelPosition(withChannelCategory(def.metadata, category), position),
            {
              actorPubkey: user.pubkey,
              version: head ? head.version + 1n : 1n,
              prevHash: head?.hash,
              authority: citationFor(community, folded, user.pubkey),
            },
          ),
        );
      }
      invalidateControl(queryClient, community.idHex);
    },
  });

  const moveChannel = useMutation<void, Error, { channelIdHex: string; direction: -1 | 1 }>({
    mutationFn: async ({ channelIdHex, direction }) => {
      const ordered = orderedForMove();
      const from = ordered.findIndex((c) => c.idHex === channelIdHex);
      if (from === -1) throw new Error("Channel not found in the control fold yet; try again shortly.");
      const to = from + direction;
      if (to < 0 || to >= ordered.length) return;
      await publishPositions(reorderPositions(ordered, from, to));
    },
  });

  /** Move a channel to an ABSOLUTE slot (drag drop index). */
  const reorderChannel = useMutation<void, Error, { channelIdHex: string; toIndex: number }>({
    mutationFn: async ({ channelIdHex, toIndex }) => {
      const ordered = orderedForMove();
      const from = ordered.findIndex((c) => c.idHex === channelIdHex);
      if (from === -1) throw new Error("Channel not found in the control fold yet; try again shortly.");
      await publishPositions(reorderPositions(ordered, from, Math.max(0, Math.min(toIndex, ordered.length - 1))));
    },
  });

  /**
   * File a channel into a category (or out with `undefined`); categories are
   * just the channels naming them. Refuses channels not yet in the fold, since
   * editing a default metadata would blank the name and make a private channel public.
   */
  const setChannelCategory = useMutation<void, Error, { channelIdHex: string; category: string | undefined }>({
    mutationFn: async ({ channelIdHex, category }) => {
      if (!user || !community) throw new Error("Not ready.");
      const trimmed = category?.trim();
      if (trimmed && utf8Len(trimmed) > NAME_MAX_BYTES) {
        throw new Error(`Category names are limited to ${NAME_MAX_BYTES} bytes.`);
      }
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found in the control fold yet; try again shortly.");
      if (def.deleted) throw new Error("This channel was deleted.");
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error("Filing a channel needs the Manage-channels permission.");
      }
      const head = folded?.heads.get(channelIdHex);
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          // Round-trip untouched metadata (CORD-02 §6).
          withChannelCategory(def.metadata, trimmed),
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl(queryClient, community.idHex);
    },
  });

  /** Set what a channel opens to (CORD-03 §2 `view`); same id, chat plane untouched. Same not-yet-folded refusal. */
  const setChannelView = useMutation<void, Error, { channelIdHex: string; view: ChannelView }>({
    mutationFn: async ({ channelIdHex, view }) => {
      if (!user || !community) throw new Error("Not ready.");
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found in the control fold yet; try again shortly.");
      if (def.deleted) throw new Error("This channel was deleted.");
      const ownerHex = folded?.ownerHex ?? community.owner;
      if (!isAuthorized(folded?.roster ?? { roles: [], grants: [] }, user.pubkey, ownerHex, Permissions.MANAGE_CHANNELS)) {
        throw new Error("Changing how a channel opens needs the Manage-channels permission.");
      }
      const head = folded?.heads.get(channelIdHex);
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          // Round-trip untouched metadata (CORD-02 §6).
          withChannelView(def.metadata, view),
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl(queryClient, community.idHex);
    },
  });

  const deleteChannel = useMutation<void, Error, { channelIdHex: string }>({
    mutationFn: async ({ channelIdHex }) => {
      if (!user || !community) throw new Error("Not ready.");
      const def = folded?.channels.get(channelIdHex);
      const head = folded?.heads.get(channelIdHex);
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          { ...(def?.metadata ?? { name: "deleted", private: false }), deleted: true },
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl(queryClient, community.idHex);
    },
  });

  const attachRepository = useMutation<void, Error, { channelIdHex: string; address: string; relayHints: string[] }>({
    mutationFn: async ({ channelIdHex, address: rawAddress, relayHints }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (!folded || !isAuthorized(folded.roster, user.pubkey, community.owner, Permissions.MANAGE_CHANNELS)) {
        throw new Error("You don't have permission to manage channels.");
      }
      const address = parseGitRepositoryAddress(rawAddress);
      if (!address) throw new Error("Repository address must be a canonical 30617 coordinate.");
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found.");
      const head = folded?.heads.get(channelIdHex);
      const createdAtSecs = Math.floor(Date.now() / 1000);
      const attachments = channelGitRepositoryAttachments(def.metadata);
      // Preserve the original active interval (and its hints) on repeat requests.
      if (attachments.some((attachment) => attachment.address.coordinate === address.coordinate && attachment.detachedAt === undefined)) return;
      const next = attachGitRepository(attachments, address, relayHints, createdAtSecs);
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildChannelEdition(hex32(channelIdHex), withChannelGitRepositoryAttachments(def.metadata, next), {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          createdAtSecs,
          authority: citationFor(community, folded, user.pubkey),
        }),
      );
      invalidateControl(queryClient, community.idHex);
    },
  });

  const detachRepository = useMutation<void, Error, { channelIdHex: string; address: string }>({
    mutationFn: async ({ channelIdHex, address: rawAddress }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (!folded || !isAuthorized(folded.roster, user.pubkey, community.owner, Permissions.MANAGE_CHANNELS)) {
        throw new Error("You don't have permission to manage channels.");
      }
      const address = parseGitRepositoryAddress(rawAddress);
      if (!address) throw new Error("Repository address must be a canonical 30617 coordinate.");
      const def = folded?.channels.get(channelIdHex);
      if (!def) throw new Error("Channel not found.");
      const head = folded?.heads.get(channelIdHex);
      const createdAtSecs = Math.floor(Date.now() / 1000);
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          withChannelGitRepositoryAttachments(def.metadata, detachGitRepository(channelGitRepositoryAttachments(def.metadata), address, createdAtSecs)),
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            createdAtSecs,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl(queryClient, community.idHex);
    },
  });

  return {
    leave: leave.mutateAsync,
    isLeaving: leave.isPending,
    dissolve: dissolve.mutateAsync,
    isDissolving: dissolve.isPending,
    createChannel: createChannel.mutateAsync,
    isAddingChannel: createChannel.isPending,
    renameChannel: renameChannel.mutateAsync,
    setChannelCategory: setChannelCategory.mutateAsync,
    isFiling: setChannelCategory.isPending,
    setChannelView: setChannelView.mutateAsync,
    isSettingView: setChannelView.isPending,
    moveChannel: moveChannel.mutateAsync,
    isMovingChannel: moveChannel.isPending,
    reorderChannel: reorderChannel.mutateAsync,
    arrangeChannels: arrangeChannels.mutateAsync,
    isArranging: arrangeChannels.isPending,
    isRenaming: renameChannel.isPending,
    privatiseChannel: privatiseChannel.mutateAsync,
    publiciseChannel: publiciseChannel.mutateAsync,
    mintAccessRole: mintAccessRole.mutateAsync,
    isMintingAccessRole: mintAccessRole.isPending,
    deleteChannel: deleteChannel.mutateAsync,
    attachRepository: attachRepository.mutateAsync,
    detachRepository: detachRepository.mutateAsync,
    entry,
  };
}

/**
 * Self-heal a STRANDED member (see useRekeyWatch): re-resolve the joined link
 * (`entry.invite_ref`) and merge a refreshed higher-epoch bundle forward via
 * the epoch-monotonic `add`, then announce a Join on the new Guestbook.
 * Polls while stranded; inert without a link ref.
 */
export function useStrandedRecovery(
  community: Community | undefined,
  stranded: boolean,
): { canRecover: boolean; checking: boolean; checkNow: () => Promise<boolean> } {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const entry = useCommunityEntry(community?.idHex);
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);

  const inviteRef = typeof entry?.invite_ref === "string" ? entry.invite_ref : undefined;
  const canRecover = Boolean(stranded && inviteRef && user && community);
  const bootstrapRelays = config.appRelays.length > 0 ? config.appRelays : STOCK_RELAYS;

  /** True when a fresher epoch was merged in. */
  const checkNow = useCallback(async (): Promise<boolean> => {
    if (!community || !user || !inviteRef || inFlight.current) return false;
    const invite = parseInviteLink(inviteRef);
    if (!invite) return false;
    inFlight.current = true;
    setChecking(true);
    try {
      const bundle = await resolveBundle(nostr, invite, bootstrapRelays);
      // The creator hasn't refreshed yet.
      if (BigInt(bundle.root_epoch) <= community.rootEpoch) return false;

      const fresh = bundleToEntry(bundle, { inviteRef });
      await updateList({ type: "add", entry: fresh });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });

      // The stranded Join went to the superseded Guestbook; announce on the new one.
      const rehydrated = rehydrateCommunity(fresh);
      if (rehydrated) {
        const attribution = bundle.creator_npub
          ? { creator: bundle.creator_npub, label: bundle.label }
          : undefined;
        queueGuestbookJoin({ viewer: user.pubkey, communityIdHex: rehydrated.idHex, ms: Date.now(), attribution });
        void attemptGuestbookJoin(nostr, rehydrated, user.signer, user.pubkey);
      }
      return true;
    } catch {
      // A revoked link can never heal this; only a fresh invite can.
      return false;
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, community?.rootEpoch, user?.pubkey, inviteRef]);

  // Never poll a closed banner.
  useEffect(() => {
    if (!canRecover) return;
    const timer = setInterval(() => void checkNow(), 60_000);
    return () => clearInterval(timer);
  }, [canRecover, checkNow]);

  return { canRecover, checking, checkNow };
}

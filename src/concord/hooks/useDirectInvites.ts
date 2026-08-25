import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { assertNotBanned, bundleToEntry } from "@/concord/hooks/useCommunityActions";
import { useCommunityList, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { concordInviteReadKey, useReadState } from "@/hooks/useReadState";
import {
  directInviteExpired,
  isCatchUpBundle,
  parseDirectInviteRumor,
  unwrapDirectInvite,
  type HeldMembership,
} from "@/concord/lib/directInvite";
import { buildJoinRumor, currentGuestbookGroup, sealGuestbook } from "@/concord/lib/guestbook";
import {
  advanceInviteInboxCursor,
  drainLiveInviteWraps,
  hasBufferedLiveInviteWraps,
  inviteInboxSince,
  queryStoredInvites,
  rebufferLiveInviteWraps,
  warmInviteInbox,
  writeStoredInvites,
} from "@/concord/lib/inviteInbox";
import { heldChannelKeys, liveEntries, rehydrateCommunity } from "@/concord/lib/communityList";
import { inviteDeliveryRelays, recipientInboxRelays } from "@/concord/lib/inviteRelays";
import { getDecryptConsent } from "@/lib/decryptConsent";
import { signerNeedsApproval } from "@/lib/bulkDecryptGate";
import { useDecryptConsent } from "@/hooks/useDecryptConsent";
import { useWireScopes } from "@/wire/useWireScopes";
import type { InviteBundle } from "@/concord/lib/invite";
import { KIND_DIRECT_INVITE, KIND_WRAP } from "@/concord/lib/kinds";

import type { NostrEvent } from "@nostrify/nostrify";

/** The signed-in user this module's background invite paths operate for. */
type InviteUser = NonNullable<ReturnType<typeof useCurrentUser>["user"]>;

/** A direct invite received over a gift wrap, awaiting the user's consent. */
export interface ParkedInvite {
  /** Gift-wrap event id (stable key + dedup). */
  wrapId: string;
  /** The inviter's pubkey (the seal author, verified). */
  sender: string;
  /** The decrypted, validated invite bundle. */
  bundle: InviteBundle;
  communityId: string;
  name: string;
  /**
   * When the invite was sent — the inner rumor's `created_at` (unix seconds).
   * The sender's word, which is fine here: it drives the inbox's newest-first
   * order and its seen/unread mark, both anti-nag rather than authority (the
   * same basis on which the decline tombstone compares against rumor time).
   */
  receivedAt: number;
  /**
   * True when this invite is for a community I'm ALREADY in, but carries a
   * higher `root_epoch` than I currently hold — an admin healing me forward
   * after I was stranded on an old epoch (CORD-05/06). The accept path merges
   * it forward only; a lower/equal epoch never parks as a catch-up.
   */
  catchUp?: boolean;
}

/**
 * May this signer decrypt in the BACKGROUND — without popping the one-time
 * consent prompt? A local nsec has no approval to gate, so it always decrypts;
 * a prompting signer (bunker/extension) holds off until consent is granted by
 * an interactive surface. Both the network sweep and the live wire wake are
 * background paths and must never open the prompt themselves.
 */
function mayDecryptInvites(method: string | undefined): boolean {
  return !signerNeedsApproval(method) || getDecryptConsent() === "allowed";
}

/**
 * Unwrap the invite wraps not already stored and persist them (two nip-44
 * decrypts per fresh wrap — the caller gates consent first). Returns how many
 * fresh records were written and the newest wrap `created_at` seen (the cursor
 * floor). Writes are keyed by wrap id, so re-seeing a wrap costs nothing.
 */
async function storeFreshInviteWraps(
  user: InviteUser,
  wraps: NostrEvent[],
  signal?: AbortSignal,
): Promise<{ stored: number; newestWrap: number }> {
  const seen = new Set((await queryStoredInvites(user.pubkey, { signal })).map((i) => i.wrapId));
  const fresh: { wrap: NostrEvent; unwrapped: NonNullable<Awaited<ReturnType<typeof unwrapDirectInvite>>> }[] = [];
  let newestWrap = 0;
  for (const wrap of wraps) {
    if (wrap.created_at > newestWrap) newestWrap = wrap.created_at;
    if (seen.has(wrap.id)) continue;
    const unwrapped = await unwrapDirectInvite(wrap, user.signer);
    if (!unwrapped) continue;
    fresh.push({ wrap, unwrapped });
  }
  await writeStoredInvites(user.pubkey, fresh);
  return { stored: fresh.length, newestWrap };
}

/**
 * The background NETWORK sweep (CORD-05 §6): fetch invite wraps newer than the
 * cursor from the recipient's own inbox relays, decrypt the consent-permitted
 * ones, persist them, advance the cursor. Returns true when it wrote something
 * new (the caller re-reads the parked set). Run un-awaited off a store read —
 * it must never block a render, the whole point of the store-first refactor.
 */
async function sweepInviteInbox(
  nostr: ReturnType<typeof useNostr>["nostr"],
  user: InviteUser,
  signal?: AbortSignal,
): Promise<boolean> {
  const pubkey = user.pubkey;
  // Fetch only wraps newer than the cursor (rewound by NIP-59's backdate window
  // — direct-invite wraps DO tweak their timestamps into the past).
  const since = await inviteInboxSince(pubkey);
  const filter: { kinds: number[]; "#p": string[]; "#k": string[]; limit: number; since?: number } = {
    kinds: [KIND_WRAP],
    "#p": [pubkey],
    "#k": [String(KIND_DIRECT_INVITE)],
    limit: 200,
  };
  if (since > 0) filter.since = since;
  // Scan exactly where senders deliver (CORD-05 §6): my own published inbox, or
  // the stock interop floor when I've published none — the same set the sender
  // resolves for me. A FAILED lookup of my OWN inbox is not "no list": scanning
  // stock on uncertainty would leak my `#p` REQ to the public stock relays.
  // Skip this round (parked invites still render); the poll retries.
  const myInbox = await recipientInboxRelays(nostr, pubkey);
  if (myInbox === null) return false;
  const scanRelays = inviteDeliveryRelays(myInbox);
  const timeout = AbortSignal.timeout(8000);
  const perRelay = await Promise.all(
    scanRelays.map((url) =>
      nostr
        .relay(url)
        .query([filter], { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
        .catch(() => [] as NostrEvent[]),
    ),
  );
  const seenWrap = new Set<string>();
  const wraps = perRelay.flat().filter((e) => (seenWrap.has(e.id) ? false : seenWrap.add(e.id)));
  if (wraps.length === 0) return false;
  // Consent gate AND cursor advance are both deferred for a prompting signer
  // without consent, so a later "allow" re-scans these wraps.
  if (!mayDecryptInvites(user.method)) return false;
  const { stored, newestWrap } = await storeFreshInviteWraps(user, wraps, signal);
  if (newestWrap > 0) await advanceInviteInboxCursor(pubkey, newestWrap);
  return stored > 0;
}

/**
 * Decrypt the invite wraps the wire buffered from its live subscription — the
 * fast live path, NO relay round-trip (the wraps are already in hand). Consent-
 * gated exactly like the sweep: a prompting signer without consent re-buffers
 * for the poll rather than popping the prompt. Returns "changed" when a new
 * invite was stored, "deferred" on a consent decline, "nochange" otherwise.
 */
async function openLiveInviteWraps(user: InviteUser): Promise<"changed" | "nochange" | "deferred"> {
  if (!user.signer.nip44) return "nochange";
  const wraps = drainLiveInviteWraps();
  if (wraps.length === 0) return "nochange";
  if (!mayDecryptInvites(user.method)) {
    rebufferLiveInviteWraps(wraps);
    return "deferred";
  }
  const { stored, newestWrap } = await storeFreshInviteWraps(user, wraps);
  if (newestWrap > 0) await advanceInviteInboxCursor(user.pubkey, newestWrap);
  return stored > 0 ? "changed" : "nochange";
}

/**
 * In-flight live drain, so the many mounted copies of {@link useDirectInvites}
 * (the notifier, the rail, the page) COALESCE onto one destructive drain rather
 * than racing it — one would win the buffer and the rest would drain empty.
 * Mirrors useDm17's `openLiveDm17Wraps`.
 */
let liveInvitePass: Promise<"changed" | "nochange" | "deferred"> | undefined;

async function drainLiveInvitesOnce(user: InviteUser): Promise<"changed" | "nochange" | "deferred"> {
  const prior = liveInvitePass;
  if (prior) {
    const result = await prior;
    // A wrap buffered while the shared pass ran still needs a drain — go again.
    // Never loop on "deferred": the decline re-buffered the wraps.
    if (result === "deferred" || !hasBufferedLiveInviteWraps()) return result;
    return drainLiveInvitesOnce(user);
  }
  const pass = openLiveInviteWraps(user);
  liveInvitePass = pass;
  try {
    return await pass;
  } finally {
    liveInvitePass = undefined;
  }
}

/**
 * The membership context the store read filters against: what each already-
 * joined community currently holds, plus the join/tombstone sets.
 */
interface ParkFilter {
  /** Communities I'm already a live member of (a non-catch-up invite skips). */
  known: ReadonlySet<string>;
  /** Newest tombstone time (ms) per community — suppresses invites SENT BEFORE it. */
  tombstonedAt: ReadonlyMap<string, number>;
  /** The held base/epoch/channel-keys per joined community, for catch-up classification. */
  heldByCommunity: ReadonlyMap<string, HeldMembership>;
}

/**
 * Collapse the parked set to one invite per community: a re-invite, or a second
 * admin inviting you to the same community, is not a second inbox row. Within a
 * group the NEWEST wrap wins (ties broken by wrap id, for a stable order).
 *
 * A catch-up is keyed by its channel set as well as its community, never by the
 * community alone: distinct catch-ups each vend a private-channel key the member
 * still lacks ({@link isCatchUpBundle} only parks those), so collapsing them by
 * community would hide a key that exists in no other wrap. Two catch-ups
 * carrying the same channels are still redundant and do collapse.
 */
export function dedupeParkedInvites(invites: ParkedInvite[]): ParkedInvite[] {
  const byKey = new Map<string, ParkedInvite>();
  for (const inv of invites) {
    const key = inv.catchUp
      ? `${inv.communityId}|${(inv.bundle.channels ?? []).map((c) => c.id.toLowerCase()).sort().join(",")}`
      : inv.communityId;
    const existing = byKey.get(key);
    if (
      !existing ||
      inv.receivedAt > existing.receivedAt ||
      (inv.receivedAt === existing.receivedAt && inv.wrapId < existing.wrapId)
    ) {
      byKey.set(key, inv);
    }
  }
  return [...byKey.values()];
}

/**
 * Read the parked invite set back from the store (no re-decrypt) and apply the
 * consent filters against the current membership list. The PURE store read the
 * hook's query, its background sweep and its live wire wake all resolve to —
 * the one place a stored record becomes a rendered {@link ParkedInvite}.
 * Deduplicated by community ({@link dedupeParkedInvites}), so the same community
 * invited more than once is one row.
 */
async function readParkedInvites(
  pubkey: string,
  filter: ParkFilter,
  signal?: AbortSignal,
): Promise<ParkedInvite[]> {
  const parked = new Map<string, ParkedInvite>();
  for (const record of await queryStoredInvites(pubkey, { signal })) {
    // The outer `k` tag was a hint; the rumor's kind + validation are the
    // authority (bounds, self-certifying owner — a forged bundle drops).
    const bundle = parseDirectInviteRumor(record.rumor.kind, record.rumor.content);
    if (!bundle) continue;
    // A dead handoff isn't worth a prompt: expired invites never park.
    if (directInviteExpired(bundle)) continue;
    // A left/declined community suppresses only the invites that predate the
    // tombstone (rumor time is the sender's word, which is fine: the gate is
    // anti-nag, not authority).
    const buriedAt = filter.tombstonedAt.get(bundle.community_id);
    if (buriedAt !== undefined && record.rumor.created_at * 1000 <= buriedAt) continue;
    // A role-gate key vend (a channel key we lack, on the base we already hold)
    // parks as a catch-up; anything else for an already-joined community is
    // noise — or a base swap — and skips.
    const catchUp = isCatchUpBundle(filter.heldByCommunity.get(bundle.community_id), bundle);
    if (filter.known.has(bundle.community_id) && !catchUp) continue;
    parked.set(record.wrapId, {
      wrapId: record.wrapId,
      sender: record.sender,
      bundle,
      communityId: bundle.community_id,
      name: bundle.name,
      receivedAt: record.rumor.created_at,
      catchUp,
    });
  }
  return dedupeParkedInvites([...parked.values()]);
}

/**
 * Scan the direct-invite inbox: the indexed CORD-05 §6 lookup
 * `{ kinds: [1059], "#p": [me], "#k": ["3313"] }` — exactly this user's
 * invites, never the whole giftwrap backlog. Each wrap is decrypted once,
 * persisted (inviteInbox), and **parked** — consent comes first: a received
 * invite never auto-joins, no relay connection or Join happens until the user
 * accepts. Already-joined or tombstoned communities are filtered out so the
 * prompt doesn't re-nag.
 *
 * The query itself is a PURE STORE READ ({@link readParkedInvites}): it reads
 * the parked set and applies the consent filters, and never blocks on the
 * network. Wraps reach the store two ways, both of which re-read into the cache
 * via setQueryData: the background {@link sweepInviteInbox} the queryFn fires
 * un-awaited, and the live `c2inv:wrap` wire wake below. This mirrors the kick
 * fix (useGuestbook): awaiting the relay round-trip here stranded every read
 * behind the recipient-inbox lookup and the 8s scan, which is why a received
 * invite only showed up after a manual refresh.
 */
export function useDirectInvites() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: list, isFetched: listFetched } = useCommunityList();
  const { consent } = useDecryptConsent();
  const queryClient = useQueryClient();

  const known = new Set(list ? liveEntries(list.list).map((e) => e.community_id) : []);
  // Newest tombstone time (ms) per community. A tombstone suppresses only
  // invites SENT BEFORE it — a leave/decline/ban buries the invites it knew
  // about, never a fresh re-invite (someone chose to ask again).
  const tombstonedAt = new Map<string, number>();
  for (const t of list?.list.tombstones ?? []) {
    const prev = tombstonedAt.get(t.community_id);
    if (prev === undefined || t.removed_at > prev) tombstonedAt.set(t.community_id, t.removed_at);
  }

  // What each already-joined community currently holds (the base, its epoch and
  // the private-channel keys), so a role-gate key vend carrying a channel key we
  // lack (CORD.md) is recognised as a CATCH-UP rather than skipped as "already a
  // member" — and a bundle proposing a DIFFERENT base is neither, and dropped.
  const heldByCommunity = useMemo(() => {
    const m = new Map<string, HeldMembership>();
    if (list) {
      for (const e of liveEntries(list.list)) {
        m.set(e.community_id, {
          rootEpoch: e.current.root_epoch,
          communityRoot: e.current.community_root,
          ...(e.current.control_pk ? { controlPk: e.current.control_pk } : {}),
          // Lowercase keys: isCatchUpBundle normalizes the bundle side the same
          // way, so one channel is one entry whatever a foreign list copy's
          // spelling was.
          channelEpochs: new Map(heldChannelKeys(e.current.channels).map((c) => [c.id.toLowerCase(), c.epoch])),
          channelCuts: new Map((e.channel_cuts ?? []).map((c) => [c.id.toLowerCase(), c.epoch])),
        });
      }
    }
    return m;
  }, [list]);

  // Don't scan until the membership list is trustworthy: an UNDECRYPTABLE read
  // (remote/bunker signer not ready) yields an untrusted empty list — treating
  // it as ready would re-park invites for communities we're already in and
  // spam the prompt on launch. A decrypt-failed list is explicitly NOT ready.
  const decryptFailed = Boolean(list?.decryptFailed);
  const listReady = !decryptFailed && (list !== undefined || listFetched);

  const filter: ParkFilter = { known, tombstonedAt, heldByCommunity };
  const queryKey = [
    "concord",
    "direct-invites",
    user?.pubkey,
    consent,
    [...known].sort().join(","),
    [...tombstonedAt.entries()].map(([id, at]) => `${id}@${at}`).sort().join(","),
  ];

  // Live wake: the wire buffered a direct-invite gift wrap it can't decrypt and
  // rang `c2inv:wrap`. Drain and decrypt the IN-HAND wrap (no relay round-trip),
  // then re-read the parked set into the cache — the same store-read-into-cache
  // the kick fix uses, NOT an invalidate (which would re-run the background
  // sweep). Gated exactly like the query's `enabled`: a not-yet-ready list would
  // otherwise re-park invites for communities we're already in.
  useWireScopes((scopes) => {
    if (!user?.signer.nip44 || !listReady || !scopes.has("c2inv:wrap")) return;
    const pubkey = user.pubkey;
    void drainLiveInvitesOnce(user)
      .then((result) => (result === "changed" ? readParkedInvites(pubkey, filter) : undefined))
      .then((rows) => {
        if (rows) queryClient.setQueryData<ParkedInvite[]>(queryKey, rows);
      })
      .catch(() => {
        // Best-effort: the poll's network sweep re-fetches the same wrap.
      });
  });

  return useQuery<ParkedInvite[]>({
    queryKey,
    enabled: Boolean(user?.signer.nip44) && listReady,
    staleTime: 30_000,
    // Invites aren't latency-critical (the user consents whenever they get to
    // it) and the cursor means a longer gap just delays discovery, never drops
    // one. Poll slowly and only while the tab is visible.
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;

      // Open this account's invite tenant now, so its cold-open (and the
      // one-time drain of the pre-tenant database) overlaps the store read.
      warmInviteInbox(pubkey);

      // The background NETWORK sweep runs UN-AWAITED (the kick-fix pattern): it
      // must never block this read behind the recipient-inbox lookup and the 8s
      // relay scan. When it writes something new, re-read the parked set into
      // the cache. Live delivery is the `c2inv:wrap` wake above; this catches
      // invites that arrived while the wire was deaf.
      void sweepInviteInbox(nostr, user!, signal)
        .then((changed) => (changed ? readParkedInvites(pubkey, filter) : undefined))
        .then((rows) => {
          if (rows) queryClient.setQueryData<ParkedInvite[]>(queryKey, rows);
        })
        .catch(() => {
          // Best-effort: the live wake and the next poll cover a miss.
        });

      return readParkedInvites(pubkey, filter, signal);
    },
  });
}

/** One row of the invite inbox: a parked invite and whether it's still unseen. */
export interface InviteInboxItem {
  invite: ParkedInvite;
  /** True until the user has opened the inbox past this invite's arrival. */
  unread: boolean;
}

export interface InviteInbox {
  /** Parked invites, newest first. */
  items: InviteInboxItem[];
  /** How many haven't been seen yet (drives the rail badge / toast). */
  unreadCount: number;
}

/**
 * The direct-invite inbox as a mail-client-style list: {@link useDirectInvites}'
 * parked invites, sorted newest-first and tagged unread against the inbox's
 * single last-seen high-water mark ({@link concordInviteReadKey}). Both the
 * routed inbox page and the rail badge read this, sharing the one underlying
 * scan query. Opening the page advances the mark, which clears every row's
 * unread flag at once.
 */
export function useInviteInbox(): InviteInbox {
  const { data: invites } = useDirectInvites();
  const { getLastRead } = useReadState();

  return useMemo(() => {
    const lastRead = getLastRead(concordInviteReadKey());
    const items: InviteInboxItem[] = (invites ?? [])
      .map((invite) => ({ invite, unread: invite.receivedAt > lastRead }))
      .sort((a, b) => b.invite.receivedAt - a.invite.receivedAt);
    const unreadCount = items.reduce((n, it) => n + (it.unread ? 1 : 0), 0);
    return { items, unreadCount };
  }, [invites, getLastRead]);
}

/**
 * Accept a parked direct invite: keep the keys — record the entry in the
 * Community List vault — then announce with a self-signed Guestbook Join
 * echoing the invite's attribution (CORD-05 §6 accepts exactly like a §1
 * link acceptance).
 *
 * A CATCH-UP invite (`invite.catchUp`) is for a community I'm already in that
 * arrived on a HIGHER epoch than I hold — an admin healing me forward after I
 * was stranded on a stale epoch. It routes through the same `add`, whose
 * deterministic list merge (`mergeEntry`/`freshest`) is epoch-monotonic: the
 * higher-epoch bundle becomes `current` while `seed` keeps my earliest root, so
 * the merge only ever moves me FORWARD — a lower/equal epoch could never reach
 * here (the scan only parks a strictly-fresher catch-up) and could not lower
 * `current` even if it did. No Guestbook Join is re-sent for a catch-up (I'm
 * already a member); only a fresh join announces.
 */
export function useAcceptDirectInvite() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const queryClient = useQueryClient();

  return useMutation<{ communityId: string; name: string }, Error, { invite: ParkedInvite }>({
    mutationFn: async ({ invite }) => {
      if (!user) throw new Error("Sign in to accept an invite.");
      const { bundle } = invite;
      if (directInviteExpired(bundle)) throw new Error("This invite has expired.");

      const entry = bundleToEntry(bundle);
      // A banned npub must not accept an invite (CORD-04 §4). This runs for a
      // catch-up too: the check is cheap, and the reasoning that once excused it
      // ("a still-valid member folding a fresher bundle isn't joining") rested on
      // the bundle being from an admin, which nothing here proves — the sender is
      // seal-verified but never rank-checked. A catch-up now rides the base the
      // member already holds (isCatchUpBundle), so this folds a Control Plane
      // under a root that is theirs rather than one the bundle chose.
      const community = rehydrateCommunity(entry);
      if (community) await assertNotBanned(nostr, community, user.pubkey);
      // `add` → mergeCommunityLists → mergeEntry → freshest (CORD-02 §8). That
      // merge reconciles a member's own devices and takes the higher epoch's
      // whole snapshot wholesale, base included — which is safe here only
      // because a catch-up is pinned to the base already held, so the sole
      // thing this can contribute for a known community is channel keys.
      await updateList({ type: "add", entry });

      // A catch-up is not a new membership: I'm already announced. Re-sending a
      // Guestbook Join would be noise. Only a genuine first join announces.
      if (!invite.catchUp) {
        // Best-effort Join, attributed to the inviter (the seal-verified sender
        // beats an unverified creator_npub claim) — coalesce self-heals if it
        // never lands.
        void (async () => {
          if (!community) return;
          const rumor = buildJoinRumor(user.pubkey, Date.now(), { creator: invite.sender, label: bundle.label });
          const wrap = await sealGuestbook(rumor, currentGuestbookGroup(community), user.signer);
          await Promise.allSettled(
            community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
          );
        })().catch(() => undefined);
      }

      return { communityId: bundle.community_id, name: bundle.name };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "direct-invites"] });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    },
  });
}

/** Decline a parked invite: tombstone the community so it stops re-nagging. */
export function useDeclineDirectInvite() {
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const queryClient = useQueryClient();

  return useMutation<void, Error, { communityId: string }>({
    mutationFn: async ({ communityId }) => {
      await updateList({ type: "remove", communityId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "direct-invites"] });
    },
  });
}

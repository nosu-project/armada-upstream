import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useCommunityEntry2, useUpdateCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { useControlFold2, useDissolved2 } from "@/concord-v2/hooks/useControlPlane2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toJoinMaterial } from "@/concord-v2/lib/communityList";
import { controlGroupKey, guestbookGroupKey } from "@/concord-v2/lib/derive";
import {
  baseRekeyGroupKey,
  bytesToHex,
  epochKeyCommitment,
  random32,
} from "@/concord-v2/lib/derive";
import { buildSnapshotRumors, sealGuestbook } from "@/concord-v2/lib/guestbook";
import { KIND_SEAL_ENCRYPTED, KIND_WRAP } from "@/concord-v2/lib/kinds";
import {
  base64ToBytes,
  buildRekeyRumors,
  bytesToBase64,
  checkContinuity,
  decodeWrappedKey,
  encodeWrappedKey,
  findBlob,
  groupRotations,
  lowerKeyWins,
  myLocator,
  parseRekey,
  rekeyScopeId,
  type ParsedRekey,
  type RekeyBlob,
} from "@/concord-v2/lib/rekey";
import { hasPermission, Permissions } from "@/concord-v2/lib/roles";
import { queryByStreams, readStreamCursor, updateStreamCursor, writeOpened } from "@/concord-v2/lib/rumorStore";
import { openWrap, rewrapSeal, sealRumor, wrapSeal, type OpenedEvent } from "@/concord-v2/lib/stream";
import type { CommunityV2, HeldRoot } from "@/concord-v2/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";

const ZERO_SCOPE = new Uint8Array(32);

/**
 * Watch the NEXT epoch's base-rekey address (CORD-06 §2) and react:
 *
 *   - a complete, authorized, continuity-checked rotation carrying MY blob →
 *     adopt the new root (retaining the prior for history) and record the
 *     refounder as the new epoch's snapshot authority;
 *   - a complete rotation with NO blob for me across ALL chunks → I've been
 *     removed; the membership entry is tombstoned. A missing chunk is never a
 *     removal — the watcher just keeps refetching.
 */
export function useRekeyWatch2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold2(community);
  const { data: dissolved } = useDissolved2(community);
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const entry = useCommunityEntry2(community?.idHex);
  const queryClient = useQueryClient();
  // One adoption/removal per (community, epoch) per session — the list update
  // re-renders with the new epoch, which re-arms the watcher naturally.
  const handled = useRef(new Set<string>());

  const nextEpoch = community ? community.rootEpoch + 1n : 0n;
  const query = useQuery<OpenedEvent[]>({
    queryKey: ["concord2", "rekey", community?.idHex ?? null, nextEpoch.toString()],
    enabled: Boolean(community),
    staleTime: 30_000,
    // Rekeys are rare, admin-initiated rotations; this watcher only runs for the
    // open community (mounted on ConcordV2Page). Poll at a relaxed cadence and
    // never while the tab is hidden — per-relay cursors below mean a longer gap
    // only delays adoption, never skips a chunk (issue #19 family).
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const address = baseRekeyGroupKey(community!.root, community!.id, nextEpoch);
      const base: { kinds: number[]; authors: string[]; limit: number } = {
        kinds: [KIND_WRAP],
        authors: [address.pk],
        limit: 50,
      };

      // PER-RELAY `since` cursors: each relay is re-asked from what IT has
      // delivered, so a fast relay can never advance a shared cursor past a
      // rekey chunk a lagging relay still owes us. A permanently-skipped chunk
      // would leave the rotation `!complete` forever — the member never adopts
      // the new epoch and every message under it stays undecryptable
      // (issue #19 family).
      const results = await Promise.all(
        community!.relays.map(async (url) => {
          const scope = `rekey:${community!.idHex}:${nextEpoch}|${url}`;
          const cursor = await readStreamCursor(scope);
          const filter = cursor?.newest ? { ...base, since: cursor.newest } : base;
          try {
            const events = await nostr
              .relay(url)
              .query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
            if (events.length > 0) {
              await updateStreamCursor(scope, {
                newest: Math.max(...events.map((e) => e.created_at)),
              });
            }
            return events;
          } catch {
            // Failed/aborted — the cursor stays put; the next poll re-asks.
            return [] as NostrEvent[];
          }
        }),
      );
      // Decrypt the stream layer once (the inner blob stays pairwise-encrypted);
      // persist the opened events so a seen rekey round is never refetched.
      const fresh: OpenedEvent[] = [];
      for (const wrap of results.flat()) {
        try {
          fresh.push(openWrap(wrap, address));
        } catch {
          // not this address / malformed
        }
      }
      if (fresh.length > 0) writeOpened(fresh);
      const stored = await queryByStreams([address.pk]);
      const byId = new Map<string, OpenedEvent>();
      for (const e of stored) byId.set(e.rumorId, e);
      for (const e of fresh) byId.set(e.rumorId, e);
      return [...byId.values()];
    },
  });

  useEffect(() => {
    if (!community || !user || !folded || !query.data || query.data.length === 0) return;
    // Death wins every race (CORD-02 §9): a Refounding never crosses the
    // owner's tombstone — no epoch advance past it is honored.
    if (dissolved) return;
    const key = `${community.idHex}:${nextEpoch}`;
    if (handled.current.has(key)) return;
    const nip44 = user.signer.nip44;
    if (!nip44) return;

    let cancelled = false;
    void (async () => {
      const parsed: ParsedRekey[] = [];
      for (const opened of query.data!) {
        try {
          parsed.push(parseRekey(opened));
        } catch {
          // not a rekey / not ours
        }
      }

      // Authorized rotators only: a removed member still holding the prior
      // root can CONSTRUCT a perfect rotation; authority is the roster, never
      // key possession (CORD-06). A banned rotator is dropped outright —
      // every event from a banned npub is, authority actions included
      // (CORD-04 §4).
      const rotations = groupRotations(parsed).filter(
        (set) =>
          set.scopeIdHex === "0".repeat(64) &&
          !folded.banned.has(set.rotator) &&
          (set.rotator === folded.ownerHex || hasPermission(folded.roster, set.rotator, Permissions.BAN)) &&
          checkContinuity(set, community.rootEpoch, community.root).ok,
      );
      if (rotations.length === 0) return;

      // Try to adopt: my blob, decrypted under the rotator↔me pairwise key.
      let adopted: { key: Uint8Array; rotator: string } | undefined;
      let sawComplete = false;
      for (const set of rotations) {
        if (!set.complete) continue;
        sawComplete = true;
        const locator = myLocator(set.rotator, user.pubkey, set.scopeIdHex, set.newEpoch);
        const blob = findBlob(set, locator);
        if (!blob) continue;
        try {
          const plainB64 = await nip44.decrypt(set.rotator, blob.wrapped);
          const newKey = decodeWrappedKey(base64ToBytes(plainB64), ZERO_SCOPE, set.newEpoch);
          // Racing rotations converge on the lexicographically lowest new key.
          if (!adopted || lowerKeyWins(adopted.key, newKey) === newKey) {
            adopted = { key: newKey, rotator: set.rotator };
          }
        } catch {
          // undecryptable blob at my locator — treat as absent
        }
      }
      if (cancelled) return;

      if (adopted) {
        handled.current.add(key);
        const heldRoots: HeldRoot[] = [
          { epoch: nextEpoch, key: adopted.key },
          ...community.heldRoots,
        ];
        const rotated: CommunityV2 = {
          ...community,
          root: adopted.key,
          rootEpoch: nextEpoch,
          heldRoots,
          refounder: adopted.rotator,
        };
        await updateList({
          type: "refresh-current",
          current: toJoinMaterial(rotated, { prior: entry?.current, relays: entry?.current.relays }),
        }).catch(() => handled.current.delete(key));
        queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
        return;
      }

      // Every chunk of at least one complete rotation held, none carries my
      // locator → removed. Tombstone the membership (the UI reflects it).
      if (sawComplete) {
        handled.current.add(key);
        await updateList({ type: "remove", communityId: community.idHex }).catch(() =>
          handled.current.delete(key),
        );
        queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, community?.rootEpoch, user?.pubkey, folded, dissolved, query.data]);
}

/**
 * A Refounding (CORD-06 §3): roll the community_root to sever the excluded,
 * re-anchor the Control Plane by compaction, and seed the new Guestbook.
 * Requires BAN (or ownership) and a NIP-44 signer — pairwise blob wrapping is
 * one ECDH either side can compute, so bunkers rotate too.
 */
export function useRefound2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const control = useControlFold2(community);
  const { data: dissolved } = useDissolved2(community);
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const entry = useCommunityEntry2(community?.idHex);
  const queryClient = useQueryClient();

  const refound = useMutation<void, Error, { keep: string[]; exclude: string[] }>({
    mutationFn: async ({ keep, exclude }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (dissolved) throw new Error("This community was dissolved; no epoch advance past the tombstone is honored.");
      const nip44 = user.signer.nip44;
      if (!nip44) throw new Error("This signer can't rotate keys (NIP-44 unsupported).");
      const folded = control.data;
      // The Refounder must reliably fold the whole Control Plane before
      // compacting, or the Refounding is aborted (CORD-06 §3).
      if (!folded || control.isLoading || control.isFetching) {
        throw new Error("Still syncing the community's control plane; try again shortly.");
      }
      const authorized = user.pubkey === folded.ownerHex || hasPermission(folded.roster, user.pubkey, Permissions.BAN);
      if (!authorized) throw new Error("You don't have permission to rotate this community's keys.");

      const excluded = new Set(exclude);
      const recipients = [...new Set([user.pubkey, ...keep])].filter((pk) => !excluded.has(pk));

      const newEpoch = community.rootEpoch + 1n;
      const newRoot = random32();
      const prevCommit = bytesToHex(epochKeyCommitment(community.rootEpoch, community.root));

      // Acquire everything BEFORE the first publish (resumable, never half-lost).
      const plain = bytesToBase64(encodeWrappedKey(ZERO_SCOPE, newEpoch, newRoot));
      const blobs: RekeyBlob[] = [];
      for (const pk of recipients) {
        const wrapped = await nip44.encrypt(pk, plain);
        blobs.push({ locator: myLocator(user.pubkey, pk, "0".repeat(64), newEpoch), wrapped });
      }

      // 1. The root roll: rekey blobs at the base address under the PRIOR root.
      const address = baseRekeyGroupKey(community.root, community.id, newEpoch);
      const rumors = buildRekeyRumors(
        user.pubkey,
        { scope: { kind: "root" }, newEpoch, prevEpoch: community.rootEpoch, prevCommit },
        blobs,
        Date.now(),
      );
      for (const rumor of rumors) {
        const wrap = wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, address, user.signer), address);
        const results = await Promise.allSettled(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
        if (!results.some((r) => r.status === "fulfilled")) {
          throw new Error("No relay accepted the key rotation.");
        }
      }

      // 2. Compaction, only after the roll published: re-wrap each entity's
      // current head (plaintext seals keep the original signatures verifiable).
      const newControl = controlGroupKey(newRoot, community.id, newEpoch);
      for (const head of folded.headEditions.values()) {
        try {
          const rewrapped = rewrapSeal(head.opened.seal, newControl);
          await Promise.allSettled(
            community.relays.map((url) => nostr.relay(url).event(rewrapped, { signal: AbortSignal.timeout(8000) })),
          );
        } catch {
          // An encrypted-seal head can't re-wrap; control heads are plaintext
          // by construction, so this is defensive only.
        }
      }

      // 3. Guestbook snapshot: best-effort, non-gating (CORD-02 §5).
      try {
        const newGuestbook = guestbookGroupKey(newRoot, community.id, newEpoch);
        const snapId = bytesToHex(random32());
        for (const rumor of buildSnapshotRumors(user.pubkey, recipients, snapId, Date.now())) {
          const wrap = await sealGuestbook(rumor, newGuestbook, user.signer);
          await Promise.allSettled(
            community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
          );
        }
      } catch {
        // A Refounding succeeds with or without the snapshot.
      }

      // 4. Follow our own rotation forward.
      const rotated: CommunityV2 = {
        ...community,
        root: newRoot,
        rootEpoch: newEpoch,
        heldRoots: [{ epoch: newEpoch, key: newRoot }, ...community.heldRoots],
        refounder: user.pubkey,
      };
      await updateList({
        type: "refresh-current",
        current: toJoinMaterial(rotated, { prior: entry?.current, relays: entry?.current.relays }),
      });
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });
    },
  });

  return {
    refound: refound.mutateAsync,
    isRefounding: refound.isPending,
    /** V2 rotations need only a NIP-44 signer (bunker-friendly), unlike V1's raw-nsec rule. */
    canRefound: Boolean(user?.signer.nip44),
  };
}

// Re-exported for the moderation hook's scope math.
export { rekeyScopeId };

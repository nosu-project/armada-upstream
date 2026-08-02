/**
 * Codifying the past: the identity-anchored author allow-list for RETIRED
 * epochs.
 *
 * A retired epoch's key is held by everyone who was ever a member, including
 * the removed — and timestamps are theirs to forge, so nothing time-shaped can
 * defend history. What CAN is authorship: every artifact below is verified by
 * a signature (the seal's, checked at open), and every anchor is spec-native:
 *
 *   - Guestbook SNAPSHOTS (CORD-02 §5): refounder-signed enumerations of the
 *     members carried into an epoch, honored only from that epoch's recorded
 *     rotator;
 *   - the ROSTER and BANLIST (CORD-04): authority-signed, compaction-anchored;
 *   - authorized KICKS (CORD-02 §5): their targets were members;
 *   - REKEY BLOBS (CORD-06): a kept member's locator is derivable from public
 *     inputs, so presence in a stored rotation is checkable per author — and
 *     the roll is publish-gated, unlike the best-effort snapshot.
 *
 * An author in none of these never verifiably existed in the community, so
 * their retired-epoch messages are display-dropped — the same mechanism as the
 * Banlist (CORD-04 §4), pointed at forged history instead of live spam.
 *
 * This deliberately inverts CORD-02 §5's "a self-signed Join is unsuppressable"
 * FOR RETIRED EPOCHS ONLY: in a dead epoch, the self-signed Join is precisely
 * the artifact an ejected keyholder forges. The live epoch keeps full spec
 * semantics.
 *
 * Known miss, accepted: a member who joined and voluntarily left within a
 * single epoch, spanning no rotation and drawing no authority action, appears
 * in no anchor — their (rare) history hides once the epoch retires. And no
 * allow-list stops a then-member backdating as THEMSELVES; that needs ordering
 * commitments the protocol doesn't have.
 */

import { KIND_KICK, KIND_SNAPSHOT } from "@/concord-v2/lib/kinds";
import { myLocator, ROOT_SCOPE_HEX, type ParsedRekey } from "@/concord-v2/lib/rekey";
import { hasPermission, Permissions, type CommunityRoles } from "@/concord-v2/lib/roles";
import type { OpenedEvent } from "@/concord-v2/lib/stream";

const HEX64 = /^[0-9a-f]{64}$/i;

export interface HistoricalAuthorInputs {
  /** The community owner (always an authority; genesis has no snapshot). */
  ownerHex: string;
  /** The viewer — their own history must never hide from them. */
  selfHex?: string;
  /** Recorded epoch rotators (per-HeldRoot `refounder` + the current one). */
  refounders?: Iterable<string | undefined>;
  /** The folded roster: grant holders were members; KICK gates kick honoring. */
  roster?: CommunityRoles;
  /** Banlisted npubs — banned members WERE members; their history stays visible
   *  only to the extent the fold's separate banlist drop allows (it doesn't),
   *  but their presence here keeps this list from being the reason. */
  banned?: Iterable<string>;
  /** Stored guestbook-plane rumors (snapshots + kicks are read; joins are NOT —
   *  a self-signed join in a retired epoch is exactly the forgeable artifact). */
  guestbook: OpenedEvent[];
  /** Stored ROOT-scope rekey rounds, parsed — blob locators prove kept members. */
  rekeyRounds?: ParsedRekey[];
  /** Authors actually appearing in retired-epoch history, for the locator check. */
  candidates?: Iterable<string>;
}

export interface HistoricalAuthorVerdict {
  /** Authors permitted to appear in retired epochs. */
  allowed: Set<string>;
  /**
   * Whether ANY anchor existed (an authority snapshot or a stored rekey round).
   * Without one — pre-rotation communities, cold caches — the caller must fail
   * OPEN: filtering against an empty anchor would hide legitimate history, and
   * this is display hardening, not consensus.
   */
  anchored: boolean;
}

/** Compute the retired-epoch author allow-list. Pure. */
export function historicalAuthorAllowlist(input: HistoricalAuthorInputs): HistoricalAuthorVerdict {
  const authorities = new Set<string>([input.ownerHex.toLowerCase()]);
  for (const r of input.refounders ?? []) {
    if (typeof r === "string" && HEX64.test(r)) authorities.add(r.toLowerCase());
  }

  const allowed = new Set<string>(authorities);
  if (input.selfHex) allowed.add(input.selfHex.toLowerCase());
  for (const pk of input.banned ?? []) allowed.add(pk.toLowerCase());
  for (const g of input.roster?.grants ?? []) allowed.add(g.member.toLowerCase());

  let sawSnapshot = false;
  for (const ev of input.guestbook) {
    if (ev.kind === KIND_SNAPSHOT) {
      // Only the recorded rotators' snapshots count (CORD-02 §5). A snapshot
      // sealed into a retired epoch by anyone else is exactly the forgery this
      // list exists to ignore.
      if (!authorities.has(ev.author)) continue;
      let members: unknown;
      try {
        members = JSON.parse(ev.content);
      } catch {
        continue;
      }
      if (!Array.isArray(members)) continue;
      sawSnapshot = true;
      for (const pk of members) {
        if (typeof pk === "string" && HEX64.test(pk)) allowed.add(pk.toLowerCase());
      }
      continue;
    }
    if (ev.kind === KIND_KICK) {
      // An authorized kick's TARGET was a member. The kick itself is
      // authority-signed; an old keyholder can't mint one that passes.
      const authorized =
        authorities.has(ev.author) ||
        (input.roster ? hasPermission(input.roster, ev.author, Permissions.KICK) : false);
      if (!authorized) continue;
      const target = ev.tags.find((t) => t[0] === "p")?.[1];
      if (target && HEX64.test(target)) allowed.add(target.toLowerCase());
    }
  }

  // Rekey-blob locator proof (CORD-06): a kept member of ANY stored rotation
  // can be verified from public inputs alone. This covers the snapshot's
  // best-effort failure mode — the roll is gated, so its blobs always landed.
  const rounds = input.rekeyRounds ?? [];
  if (rounds.length > 0 && input.candidates) {
    const locatorSets = rounds.map((r) => ({
      rotator: r.rotator,
      newEpoch: r.newEpoch,
      locators: new Set(r.blobs.map((b) => b.locator)),
    }));
    for (const raw of input.candidates) {
      const pk = raw.toLowerCase();
      if (allowed.has(pk) || !HEX64.test(pk)) continue;
      for (const round of locatorSets) {
        if (round.locators.has(myLocator(round.rotator, pk, ROOT_SCOPE_HEX, round.newEpoch))) {
          allowed.add(pk);
          break;
        }
      }
    }
  }

  return { allowed, anchored: sawSnapshot || rounds.length > 0 };
}

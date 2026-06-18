/**
 * Per-entity version chain for authority editions — ported from Vector's
 * `community/version.rs`.
 *
 * Every authority record (Grant, RoleMetadata, Banlist, OwnerAttestation) is a
 * sequence of editions, each carrying a monotonic `version` + the hash of its
 * predecessor (`prevHash`), the actor's real-npub signature covering both.
 * Clients fold the fetched set into the current head by: refuse-downgrade,
 * deterministic equal-version tiebreak (lower inner edition id), and contiguous
 * chain-walk with gap detection (fail closed).
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const EDITION_LABEL = new TextEncoder().encode("vector-community/v1/edition");

function u64be(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, false);
  return out;
}

/**
 * Domain-separated, length-prefixed canonical bytes an authority edition commits
 * to. Layout (FROZEN): `u64_be(label.len) ‖ label ‖ entity_id[32] ‖
 * u64_be(version) ‖ has_prev(1) ‖ prev_hash[32 or zero] ‖ u64_be(content.len) ‖
 * content`.
 */
export function editionSigningBytes(
  entityId: Uint8Array,
  version: bigint,
  prevHash: Uint8Array | undefined,
  content: Uint8Array,
): Uint8Array {
  const parts: Uint8Array[] = [
    u64be(BigInt(EDITION_LABEL.length)),
    EDITION_LABEL,
    entityId,
    u64be(version),
    new Uint8Array([prevHash ? 1 : 0]),
    prevHash ?? new Uint8Array(32),
    u64be(BigInt(content.length)),
    content,
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** SHA-256 of {@link editionSigningBytes} — the edition's identity in the chain. */
export function editionHash(
  entityId: Uint8Array,
  version: bigint,
  prevHash: Uint8Array | undefined,
  content: Uint8Array,
): Uint8Array {
  return sha256(editionSigningBytes(entityId, version, prevHash, content));
}

/** One fetched edition of an entity, reduced to what the fold needs. */
export interface Edition {
  version: bigint;
  prevHash?: Uint8Array;
  /** `editionHash` of THIS edition (what the next edition's prevHash must cite). */
  selfHash: Uint8Array;
  createdAt: number;
  /** Inner event id — the deterministic equal-version tiebreak. */
  tiebreakId: Uint8Array;
}

export interface FoldResult {
  /** Index of the chosen head edition, or null if nothing ≥ floor. */
  head: number | null;
  /** A higher version exists but doesn't link contiguously — fail closed + refetch. */
  gap: boolean;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function bytesEq(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && cmpBytes(a, b) === 0;
}

/**
 * Fold a set of editions for ONE entity into its current head. `floor` is the
 * highest version already accepted (0n = none), `floorHash` that held edition's
 * selfHash. See module doc + Vector `version.rs` for the full rule set.
 */
export function fold(editions: Edition[], floor: bigint, floorHash?: Uint8Array): FoldResult {
  // Per-version winner (equal-version fork → lower tiebreakId). Skip below-floor.
  const byVersion = new Map<bigint, number>();
  for (let i = 0; i < editions.length; i++) {
    const e = editions[i];
    if (e.version < floor) continue;
    const j = byVersion.get(e.version);
    if (j === undefined) {
      byVersion.set(e.version, i);
    } else if (cmpBytes(e.tiebreakId, editions[j].tiebreakId) < 0) {
      byVersion.set(e.version, i);
    }
  }
  const versions = [...byVersion.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (versions.length === 0) return { head: null, gap: false };

  const lo = editions[byVersion.get(versions[0])!];
  let anchored: boolean;
  if (floor === 0n) {
    anchored = versions[0] === 1n && lo.prevHash === undefined;
  } else if (versions[0] === floor) {
    anchored = floorHash !== undefined && bytesEq(floorHash, lo.selfHash);
  } else if (versions[0] === floor + 1n) {
    anchored = floorHash !== undefined && bytesEq(lo.prevHash, floorHash);
  } else {
    anchored = false;
  }
  let gap = !anchored;

  let headIdx = byVersion.get(versions[0])!;
  for (let k = 0; k + 1 < versions.length; k++) {
    const loIdx = byVersion.get(versions[k])!;
    const hiIdx = byVersion.get(versions[k + 1])!;
    const linked =
      versions[k + 1] === versions[k] + 1n && bytesEq(editions[hiIdx].prevHash, editions[loIdx].selfHash);
    if (linked) {
      headIdx = hiIdx;
    } else {
      gap = true;
      break;
    }
  }
  return { head: headIdx, gap };
}

/**
 * The head a BOOTSTRAPPING client accepts: the per-version winner at the highest
 * present version ≥ floor, ignoring chain contiguity (a fresh joiner can't verify
 * lineage; the gate is the signature + the author's current authority). Equal
 * versions use the same lower-inner-id tiebreak.
 */
export function bootstrapHead(editions: Edition[], floor: bigint): number | null {
  let best: number | null = null;
  for (let i = 0; i < editions.length; i++) {
    const e = editions[i];
    if (e.version < floor) continue;
    if (best === null) {
      best = i;
    } else {
      const cur = editions[best];
      const take =
        e.version > cur.version ||
        (e.version === cur.version && cmpBytes(e.tiebreakId, cur.tiebreakId) < 0);
      if (take) best = i;
    }
  }
  return best;
}

export { bytesToHex };

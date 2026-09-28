/**
 * BIP-374 Discrete Log Equality (DLEQ) proofs, used by BIP-375 to prove PSBT
 * ECDH shares came from the input keys without revealing them. Implements
 * `GenerateProof(a, B, r, G, m)` / `VerifyProof(A, B, C, proof, G, m)` from
 * BIP-374 v0.2.0 (`G` defaults to secp256k1's generator; omitted `m` commits to
 * an empty message). Tested against `src/test/fixtures/bip374_*.csv`.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha256';

/** secp256k1 Point class (`schnorr.Point`). */
const Point = schnorr.Point;
const POINT_ZERO = Point.ZERO;

/** secp256k1 group order. */
const SECP_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** secp256k1 standard generator G, compressed. */
const SECP256K1_G_COMPRESSED = hexToBytes(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
);

function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  // Fresh Uint8Array so noble's `u8a` check passes under jsdom (as in silentPayments.ts).
  const tagBytes = new Uint8Array(new TextEncoder().encode(tag));
  const tagHash = sha256(tagBytes);
  const data = new Uint8Array(tagHash.length * 2 + msg.length);
  data.set(tagHash, 0);
  data.set(tagHash, tagHash.length);
  data.set(msg, tagHash.length * 2);
  return sha256(data);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length string.');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToScalar(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

function scalarToBytes(s: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = s;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new Error('xorBytes: length mismatch.');
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function ensure33(p: Uint8Array, name: string): Uint8Array {
  if (p.length !== 33) {
    throw new Error(`DLEQ: ${name} must be 33-byte compressed point (got ${p.length}).`);
  }
  if (p[0] !== 0x02 && p[0] !== 0x03) {
    throw new Error(`DLEQ: ${name} has invalid compression prefix 0x${p[0].toString(16)}.`);
  }
  return p;
}

function ensure32(b: Uint8Array, name: string): Uint8Array {
  if (b.length !== 32) {
    throw new Error(`DLEQ: ${name} must be 32 bytes (got ${b.length}).`);
  }
  return b;
}

/** True iff `g` is the standard secp256k1 generator. */
function isStandardG(g: Uint8Array): boolean {
  if (g.length !== SECP256K1_G_COMPRESSED.length) return false;
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== SECP256K1_G_COMPRESSED[i]) return false;
  }
  return true;
}

/** Parse a 33-byte compressed point; `null` on any error (the verifier must never throw). */
function tryDecodePoint(bytes: Uint8Array): InstanceType<typeof Point> | null {
  if (bytes.length !== 33) return null;
  if (bytes[0] !== 0x02 && bytes[0] !== 0x03) return null;
  try {
    return Point.fromBytes(bytes);
  } catch {
    return null;
  }
}

export interface DLEQProveInput {
  /** Secret scalar `a` (32 bytes, 0 < a < n). */
  a: Uint8Array;
  /** Public point `B` (33-byte compressed). */
  B: Uint8Array;
  /** Auxiliary randomness `r` (32 bytes), fresh per call (BIP-374 footnote); caller supplies entropy. */
  auxRand: Uint8Array;
  /** Optional generator `G` (33-byte compressed); defaults to secp256k1's. */
  G?: Uint8Array;
  /** Optional 32-byte message commitment. */
  message?: Uint8Array;
}

export interface DLEQProveResult {
  /** 64-byte DLEQ proof (`bytes(32, e) || bytes(32, s)`). */
  proof: Uint8Array;
  /** `A = a·G`, the public counterpart of the secret. */
  A: Uint8Array;
  /** `C = a·B`, the proved ECDH share. */
  C: Uint8Array;
}

/**
 * BIP-374 `GenerateProof(a, B, r, G, m)`. Throws on the BIP's aborts (a out of
 * range, invalid B, k = 0) or if self-verification fails.
 */
export function generateDLEQProof(input: DLEQProveInput): DLEQProveResult {
  const a = ensure32(input.a, 'a');
  const B = ensure33(input.B, 'B');
  const auxRand = ensure32(input.auxRand, 'auxRand');
  const G = input.G ? ensure33(input.G, 'G') : SECP256K1_G_COMPRESSED;
  const message = input.message ? ensure32(input.message, 'message') : new Uint8Array(0);

  const aScalar = bytesToScalar(a);
  if (aScalar === 0n || aScalar >= SECP_N) {
    throw new Error('DLEQ: secret scalar `a` is out of range.');
  }

  // `Point.fromBytes` rejects off-curve points, covering the BIP's "B = infinity" abort.
  let BPoint: InstanceType<typeof Point>;
  try {
    BPoint = Point.fromBytes(B);
  } catch (err) {
    throw new Error(`DLEQ: B is not a valid compressed point (${(err as Error).message}).`, {
      cause: err,
    });
  }

  let GPoint: InstanceType<typeof Point>;
  if (isStandardG(G)) {
    GPoint = Point.BASE;
  } else {
    try {
      GPoint = Point.fromBytes(G);
    } catch (err) {
      throw new Error(`DLEQ: G is not a valid compressed point (${(err as Error).message}).`, {
        cause: err,
      });
    }
  }

  // A = a·G, C = a·B
  const A = GPoint.multiply(aScalar).toBytes(true);
  const C = BPoint.multiply(aScalar).toBytes(true);

  // t = a XOR hash_{BIP0374/aux}(r)
  const auxTag = taggedHash('BIP0374/aux', auxRand);
  const t = xorBytes(a, auxTag);

  // rand = hash_{BIP0374/nonce}(t || cbytes(A) || cbytes(C) || m')
  const rand = taggedHash('BIP0374/nonce', concatBytes(t, A, C, message));
  const k = bytesToScalar(rand) % SECP_N;
  if (k === 0n) {
    throw new Error('DLEQ: derived nonce k is zero.');
  }

  // R1 = k·G, R2 = k·B
  const R1 = GPoint.multiply(k).toBytes(true);
  const R2 = BPoint.multiply(k).toBytes(true);

  // e = int(hash_{BIP0374/challenge}(cbytes(A) || cbytes(B) || cbytes(C) || cbytes(G) || cbytes(R1) || cbytes(R2) || m'))
  const eHash = taggedHash(
    'BIP0374/challenge',
    concatBytes(A, B, C, G, R1, R2, message),
  );
  const eScalar = bytesToScalar(eHash) % SECP_N;
  const eBytes = scalarToBytes(eScalar);

  // s = (k + e·a) mod n
  const s = (k + (eScalar * aScalar) % SECP_N) % SECP_N;
  const sBytes = scalarToBytes(s);

  const proof = concatBytes(eBytes, sBytes);

  // Sanity check per the BIP: verify before returning.
  if (!verifyDLEQProof({ A, B, C, proof, G, message: input.message })) {
    throw new Error('DLEQ: self-verification of generated proof failed.');
  }

  return { proof, A, C };
}

export interface DLEQVerifyInput {
  /** Public point `A` (33-byte compressed). */
  A: Uint8Array;
  /** Public point `B` (33-byte compressed). */
  B: Uint8Array;
  /** Public point `C` (33-byte compressed). */
  C: Uint8Array;
  /** 64-byte proof produced by {@link generateDLEQProof}. */
  proof: Uint8Array;
  /** Optional generator `G`; must match the one used to generate. */
  G?: Uint8Array;
  /** Optional 32-byte message commitment. */
  message?: Uint8Array;
}

/** BIP-374 `VerifyProof(A, B, C, proof, G, m)`. Never throws; malformed input returns `false`. */
export function verifyDLEQProof(input: DLEQVerifyInput): boolean {
  try {
    if (input.proof.length !== 64) return false;

    const APoint = tryDecodePoint(input.A);
    const BPoint = tryDecodePoint(input.B);
    const CPoint = tryDecodePoint(input.C);
    if (!APoint || !BPoint || !CPoint) return false;

    const G = input.G ?? SECP256K1_G_COMPRESSED;
    if (G.length !== 33) return false;
    const GPoint = isStandardG(G) ? Point.BASE : tryDecodePoint(G);
    if (!GPoint) return false;

    if (input.message !== undefined && input.message.length !== 32) return false;
    const message = input.message ?? new Uint8Array(0);

    const eScalar = bytesToScalar(input.proof.subarray(0, 32)) % SECP_N;
    const sScalar = bytesToScalar(input.proof.subarray(32, 64));
    if (sScalar >= SECP_N) return false;

    // R1 = s·G - e·A (`multiplyUnsafe` accepts 0; public points only)
    const R1Point = GPoint.multiplyUnsafe(sScalar).add(
      APoint.multiplyUnsafe(eScalar).negate(),
    );
    if (R1Point.equals(POINT_ZERO)) return false;

    // R2 = s·B - e·C
    const R2Point = BPoint.multiplyUnsafe(sScalar).add(
      CPoint.multiplyUnsafe(eScalar).negate(),
    );
    if (R2Point.equals(POINT_ZERO)) return false;

    const R1 = R1Point.toBytes(true);
    const R2 = R2Point.toBytes(true);

    const expected = taggedHash(
      'BIP0374/challenge',
      concatBytes(input.A, input.B, input.C, G, R1, R2, message),
    );
    // `e` is encoded as the unreduced hash; compare raw bytes.
    const eBytes = input.proof.subarray(0, 32);
    if (expected.length !== eBytes.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== eBytes[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Keep `POINT_ZERO` referenced so aggressive tree-shaking can't drop `Point.ZERO`.
void POINT_ZERO;

/** @internal Constants exposed for tests. */
export const _internal = {
  SECP256K1_G_COMPRESSED,
  SECP_N,
};

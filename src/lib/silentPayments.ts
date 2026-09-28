/**
 * BIP352 Silent Payments — sender side. Derives the one-shot Taproot outputs:
 *   a          = sum of input private keys (Taproot keys negated if odd Y)
 *   A          = a·G
 *   input_hash = hashBIP0352/Inputs(outpoint_L || serP(A))
 *   ecdh       = input_hash·a·B_scan
 *   t_k        = hashBIP0352/SharedSecret(serP(ecdh) || ser32(k))
 *   P_mn       = B_spend + t_k·G   (x-only BIP341 output)
 * No receiver scanning or labels. Verified against BIP352 test vectors
 * (`src/test/fixtures/bip352_sender_vectors.json`).
 */
import * as btc from '@scure/btc-signer';
import { taprootTweakPrivKey } from '@scure/btc-signer/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha256';
import {
  type SilentPaymentAddress,
} from './silentPaymentsCore';

// Re-exported so wallet code can import everything from here.
export {
  isSilentPaymentAddress,
  decodeSilentPaymentAddress,
  validateSilentPaymentAddress,
  type SilentPaymentAddress,
  type SilentPaymentNetwork,
} from './silentPaymentsCore';

const Point = schnorr.Point;

// BIP-340-style tagged hash: SHA256(SHA256(tag) || SHA256(tag) || msg).
function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  // Copy: jsdom's TextEncoder returns a cross-realm Uint8Array that fails noble's check.
  const tagBytes = new Uint8Array(new TextEncoder().encode(tag));
  const tagHash = sha256(tagBytes);
  const data = new Uint8Array(tagHash.length * 2 + msg.length);
  data.set(tagHash, 0);
  data.set(tagHash, tagHash.length);
  data.set(msg, tagHash.length * 2);
  return sha256(data);
}

function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`ser32: out of range (${n}).`);
  }
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
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

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}


function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length string.');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error('hexToBytes: invalid character.');
    out[i] = b;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i].toString(16).padStart(2, '0');
  }
  return s;
}

/** 32-byte big-endian → bigint. */
function bytesToScalar(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

const SECP_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function scalarToBytes(s: bigint): Uint8Array {
  if (s <= 0n || s >= SECP_N) {
    throw new Error('Scalar out of range.');
  }
  const out = new Uint8Array(32);
  let v = s;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Derive the 33-byte compressed pubkey for a 32-byte scalar. */
function pubKeyFromScalar(privateKey: Uint8Array): Uint8Array {
  const k = bytesToScalar(privateKey);
  if (k === 0n || k >= SECP_N) {
    throw new Error('Silent payment: invalid input private key.');
  }
  return Point.BASE.multiply(k).toBytes(true);
}

/** Negate a 32-byte private key mod N. */
function privateNegate(privateKey: Uint8Array): Uint8Array {
  const k = bytesToScalar(privateKey);
  if (k === 0n || k >= SECP_N) {
    throw new Error('Silent payment: invalid input private key.');
  }
  return scalarToBytes(SECP_N - k);
}

/**
 * Serialize an outpoint as in a transaction: 32-byte little-endian txid +
 * 4-byte LE vout. `txid` is display hex unless `txidIsLittleEndian`.
 */
function serializeOutpoint(
  txidHex: string,
  vout: number,
  txidIsLittleEndian = false,
): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(txidHex)) {
    throw new Error('outpoint: txid must be 32-byte hex.');
  }
  const txid = hexToBytes(txidHex);
  if (!txidIsLittleEndian) {
    txid.reverse();
  }
  const voutBuf = new Uint8Array(4);
  voutBuf[0] = vout & 0xff;
  voutBuf[1] = (vout >>> 8) & 0xff;
  voutBuf[2] = (vout >>> 16) & 0xff;
  voutBuf[3] = (vout >>> 24) & 0xff;
  return concatBytes(txid, voutBuf);
}

/**
 * A sender input contributing to BIP352 ECDH. For Taproot, `privateKey` is the
 * BIP341 *tweaked* signing key, not the internal key.
 */
export interface SilentPaymentInput {
  txid: string;
  vout: number;
  privateKey: Uint8Array;
  /** Optional override; if absent, derived from `privateKey`. */
  pubkey?: Uint8Array;
  isTaproot: boolean;
}

/** A single resolved silent payment recipient + amount. */
export interface SilentPaymentRecipient {
  address: SilentPaymentAddress;
  /** Original address string (diagnostics). */
  raw?: string;
}

/** One sender output (the receiver's per-`k` taproot output). */
export interface SilentPaymentOutput {
  /** 32-byte x-only taproot key — the value of the output's scriptPubKey. */
  xOnlyPubKey: Uint8Array;
  /** Convenience: the matching mainnet/testnet P2TR address. */
  address: string;
  recipient: SilentPaymentRecipient;
}

/**
 * Compute BIP352 sender outputs. The inputs MUST be final: any change
 * invalidates the outputs. `allOutpoints` must include INELIGIBLE inputs too,
 * since outpoint_L is the smallest across the whole transaction (defaults to
 * the eligible ones). Recipients sharing a scan key share `k = 0, 1, …`;
 * throws if a group exceeds K_max = 2323 or any scalar is invalid.
 */
export function deriveSilentPaymentOutputs(
  eligibleInputs: SilentPaymentInput[],
  recipients: SilentPaymentRecipient[],
  options: {
    /** Outpoints of every input in the tx; see above. */
    allOutpoints?: { txid: string; vout: number }[];
    network?: 'mainnet' | 'testnet';
  } = {},
): SilentPaymentOutput[] {
  const network = options.network ?? 'mainnet';
  const inputs = eligibleInputs;
  if (inputs.length === 0) {
    throw new Error('Silent payment: at least one eligible input is required.');
  }
  if (recipients.length === 0) return [];

  // K_max check first, before any crypto work.
  const K_MAX = 2323;
  const groups = new Map<string, SilentPaymentRecipient[]>();
  for (const r of recipients) {
    const key = bytesToHex(r.address.scanPubKey);
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  for (const arr of groups.values()) {
    if (arr.length > K_MAX) {
      throw new Error(`Silent payment: recipient group exceeds K_max=${K_MAX}.`);
    }
  }

  let aSum = 0n;
  for (const input of inputs) {
    if (input.privateKey.length !== 32) {
      throw new Error('Silent payment: input private key must be 32 bytes.');
    }
    let pk = input.privateKey;
    if (input.isTaproot) {
      const pubFull = pubKeyFromScalar(pk);
      if (pubFull[0] === 0x03) {
        pk = privateNegate(pk);
      }
    }
    const scalar = bytesToScalar(pk);
    if (scalar === 0n || scalar >= SECP_N) {
      throw new Error('Silent payment: input private key out of range.');
    }
    aSum = (aSum + scalar) % SECP_N;
  }
  if (aSum === 0n) {
    throw new Error('Silent payment: sum of input private keys is zero.');
  }

  const aPub = Point.BASE.multiply(aSum).toBytes(true);

  const outpointsForHash = options.allOutpoints ?? inputs.map((i) => ({ txid: i.txid, vout: i.vout }));
  if (outpointsForHash.length === 0) {
    throw new Error('Silent payment: no outpoints provided.');
  }
  let smallest: Uint8Array | null = null;
  for (const op of outpointsForHash) {
    const ser = serializeOutpoint(op.txid, op.vout);
    if (smallest === null || compareBytes(ser, smallest) < 0) {
      smallest = ser;
    }
  }
  if (!smallest) throw new Error('Silent payment: no outpoints.');

  const inputHash = taggedHash(
    'BIP0352/Inputs',
    concatBytes(smallest, aPub),
  );
  const inputHashScalar = bytesToScalar(inputHash);
  if (inputHashScalar === 0n || inputHashScalar >= SECP_N) {
    throw new Error('Silent payment: invalid input_hash.');
  }

  const out: SilentPaymentOutput[] = [];
  for (const group of groups.values()) {
    // ecdh = ((input_hash * a) mod n) · B_scan
    const scanPoint = Point.fromBytes(group[0].address.scanPubKey);
    const combinedScalar = (inputHashScalar * aSum) % SECP_N;
    if (combinedScalar === 0n) {
      throw new Error('Silent payment: input_hash · a is zero.');
    }
    const ecdh = scanPoint.multiply(combinedScalar).toBytes(true);

    let k = 0;
    for (const recipient of group) {
      const tK = taggedHash(
        'BIP0352/SharedSecret',
        concatBytes(ecdh, u32be(k)),
      );
      const tScalar = bytesToScalar(tK);
      if (tScalar === 0n || tScalar >= SECP_N) {
        throw new Error('Silent payment: invalid t_k.');
      }

      // P_mn = B_spend + t_k·G
      const spendPoint = Point.fromBytes(recipient.address.spendPubKey);
      const P = spendPoint.add(Point.BASE.multiply(tScalar));
      // x=y=0 affine means the point at infinity.
      const Paff = P.toAffine();
      if (Paff.x === 0n && Paff.y === 0n) {
        throw new Error('Silent payment: B_spend + t_k·G is point at infinity.');
      }
      const Pbytes = P.toBytes(true);

      const xonly = new Uint8Array(Pbytes.subarray(1, 33));
      const addr = encodeP2TR(xonly, network);
      out.push({ xOnlyPubKey: xonly, address: addr, recipient });
      k++;
    }
  }

  return out;
}

/** Encode an x-only key as a P2TR address using @scure/btc-signer. */
function encodeP2TR(xonly: Uint8Array, network: 'mainnet' | 'testnet'): string {
  const net = network === 'mainnet' ? btc.NETWORK : btc.TEST_NETWORK;
  // Given the OUTPUT key with no script tree, so `.address` encodes OP_1 <xonly>.
  const pay = btc.p2tr(xonly, undefined, net);
  if (!pay.address) {
    throw new Error('Silent payment: failed to encode P2TR address.');
  }
  return pay.address;
}

/** The 34-byte P2TR scriptPubKey (`OP_1 push32 <xonly>`). */
export function p2trScriptPubKey(xonly: Uint8Array): Uint8Array {
  if (xonly.length !== 32) {
    throw new Error('p2trScriptPubKey: xonly key must be 32 bytes.');
  }
  const out = new Uint8Array(34);
  out[0] = 0x51; // OP_1
  out[1] = 0x20; // push 32 bytes
  out.set(xonly, 2);
  return out;
}

/** Output of {@link aggregateSenderPrivateKey}. */
export interface AggregateSenderKey {
  /** Aggregate scalar `a = Σ a_i` after BIP-352 parity-flip on Taproot inputs (32 bytes). */
  aggregateScalar: Uint8Array;
  /** `A = a·G` (33-byte compressed). */
  aggregatePubKey: Uint8Array;
  /** Smallest serialized outpoint across the full input set. */
  outpointL: Uint8Array;
  /** `input_hash = hashBIP0352/Inputs(outpoint_L || serP(A))` (32 bytes). */
  inputHash: Uint8Array;
}

/**
 * Compute `a` (with BIP-352 odd-Y negation of tweaked Taproot keys), `A`,
 * outpoint_L and `input_hash`. `allOutpoints` must cover ineligible inputs too.
 */
export function aggregateSenderPrivateKey(
  eligibleInputs: SilentPaymentInput[],
  allOutpoints?: { txid: string; vout: number }[],
): AggregateSenderKey {
  if (eligibleInputs.length === 0) {
    throw new Error('Silent payment: at least one eligible input is required.');
  }

  let aSum = 0n;
  for (const input of eligibleInputs) {
    if (input.privateKey.length !== 32) {
      throw new Error('Silent payment: input private key must be 32 bytes.');
    }
    let pk = input.privateKey;
    if (input.isTaproot) {
      const pubFull = pubKeyFromScalar(pk);
      if (pubFull[0] === 0x03) {
        pk = privateNegate(pk);
      }
    }
    const scalar = bytesToScalar(pk);
    if (scalar === 0n || scalar >= SECP_N) {
      throw new Error('Silent payment: input private key out of range.');
    }
    aSum = (aSum + scalar) % SECP_N;
  }
  if (aSum === 0n) {
    throw new Error('Silent payment: sum of input private keys is zero.');
  }
  const aBytes = scalarToBytes(aSum);
  const aPub = Point.BASE.multiply(aSum).toBytes(true);

  const outpointsForHash =
    allOutpoints ?? eligibleInputs.map((i) => ({ txid: i.txid, vout: i.vout }));
  if (outpointsForHash.length === 0) {
    throw new Error('Silent payment: no outpoints provided.');
  }
  let smallest: Uint8Array | null = null;
  for (const op of outpointsForHash) {
    const ser = serializeOutpoint(op.txid, op.vout);
    if (smallest === null || compareBytes(ser, smallest) < 0) {
      smallest = ser;
    }
  }
  if (!smallest) throw new Error('Silent payment: no outpoints.');

  const inputHash = taggedHash(
    'BIP0352/Inputs',
    concatBytes(smallest, aPub),
  );
  const inputHashScalar = bytesToScalar(inputHash);
  if (inputHashScalar === 0n || inputHashScalar >= SECP_N) {
    throw new Error('Silent payment: invalid input_hash.');
  }

  return {
    aggregateScalar: aBytes,
    aggregatePubKey: aPub,
    outpointL: smallest,
    inputHash,
  };
}

/**
 * BIP-375 ECDH share `C = a · B_scan` — NOT BIP-352's `input_hash · a · B_scan`;
 * the verifier multiplies by `input_hash` after checking the DLEQ proof.
 */
export function computeBip375EcdhShare(
  aggregateScalar: Uint8Array,
  scanPubKey: Uint8Array,
): Uint8Array {
  const k = bytesToScalar(aggregateScalar);
  if (k === 0n || k >= SECP_N) {
    throw new Error('Silent payment: aggregate scalar out of range.');
  }
  const scanPoint = Point.fromBytes(scanPubKey);
  return scanPoint.multiply(k).toBytes(true);
}

/**
 * BIP341 key-path tweak of an nsec used as a Taproot internal key: the scalar
 * that signs the wallet's P2TR inputs and joins BIP352's `a` sum.
 */
export function tweakNsecForTaproot(privateKeyHex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error('Private key must be 32-byte hex.');
  }
  const d = hexToBytes(privateKeyHex);
  const k = bytesToScalar(d);
  if (k === 0n || k >= SECP_N) {
    throw new Error('Invalid private key.');
  }
  return new Uint8Array(taprootTweakPrivKey(d));
}

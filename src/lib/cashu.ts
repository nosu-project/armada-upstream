/**
 * Cashu ecash token parsing (NUT-00): `cashuA` (v3, JSON) or `cashuB` (v4,
 * CBOR) + base64url. Only the envelope is parsed, to render and state-check;
 * nothing here spends.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";

/**
 * Serialized token, optionally behind `cashu:`. Callers may apply the `i` flag;
 * `parseCashuToken` re-validates.
 */
export const CASHU_TOKEN_PATTERN = "(?:cashu:)?cashu[AB][A-Za-z0-9_-]{20,}={0,2}";

export interface CashuTokenInfo {
  version: 3 | 4;
  amount: number;
  /** Defaults to `sat` when absent. */
  unit: string;
  /** Empty when the token omits it. */
  mint: string;
  memo?: string;
  proofs: number;
  /** Proof secrets, for NUT-07 `Y` points. */
  secrets: string[];
}

/** Decode unpadded/padded base64url to bytes. Returns null on invalid input. */
function base64urlToBytes(input: string): Uint8Array | null {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | { [key: string]: CborValue };

/** Minimal CBOR decoder for the v4 token subset; indefinite lengths, tags and floats throw. */
function decodeCbor(bytes: Uint8Array): CborValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const readLength = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return view.getUint8(pos++);
    if (info === 25) {
      const v = view.getUint16(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      const v = view.getUint32(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      const v = view.getBigUint64(pos);
      pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cbor: integer too large");
      return Number(v);
    }
    throw new Error("cbor: unsupported length encoding");
  };

  const readValue = (): CborValue => {
    if (pos >= bytes.length) throw new Error("cbor: unexpected end of input");
    const initial = view.getUint8(pos++);
    const major = initial >> 5;
    const info = initial & 0x1f;

    switch (major) {
      case 0:
        return readLength(info);
      case 1:
        return -1 - readLength(info);
      case 2: {
        const len = readLength(info);
        const slice = bytes.subarray(pos, pos + len);
        if (slice.length !== len) throw new Error("cbor: truncated byte string");
        pos += len;
        return slice;
      }
      case 3: {
        const len = readLength(info);
        const slice = bytes.subarray(pos, pos + len);
        if (slice.length !== len) throw new Error("cbor: truncated text string");
        pos += len;
        return new TextDecoder().decode(slice);
      }
      case 4: {
        const len = readLength(info);
        const arr: CborValue[] = [];
        for (let i = 0; i < len; i++) arr.push(readValue());
        return arr;
      }
      case 5: {
        const len = readLength(info);
        const map: { [key: string]: CborValue } = {};
        for (let i = 0; i < len; i++) {
          const key = readValue();
          const value = readValue();
          if (typeof key === "string") map[key] = value;
        }
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return null;
        throw new Error("cbor: unsupported simple value");
      default:
        throw new Error("cbor: unsupported major type");
    }
  };

  return readValue();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && !(value instanceof Uint8Array);
}

/** Tally a proof list, ignoring malformed entries (keys differ between v3 and v4). */
function collectProofs(
  proofs: unknown,
  amountKey: string,
  secretKey: string,
): { amount: number; count: number; secrets: string[] } {
  if (!Array.isArray(proofs)) return { amount: 0, count: 0, secrets: [] };
  let amount = 0;
  let count = 0;
  const secrets: string[] = [];
  for (const proof of proofs) {
    if (!isRecord(proof)) continue;
    const value = proof[amountKey];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      amount += value;
      count++;
    }
    const secret = proof[secretKey];
    if (typeof secret === "string" && secret) secrets.push(secret);
  }
  return { amount, count, secrets };
}

function parseV3(payload: string): CashuTokenInfo | null {
  const bytes = base64urlToBytes(payload);
  if (!bytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(json) || !Array.isArray(json.token)) return null;

  let amount = 0;
  let proofs = 0;
  let mint = "";
  const secrets: string[] = [];
  for (const entry of json.token) {
    if (!isRecord(entry)) continue;
    if (!mint && typeof entry.mint === "string") mint = entry.mint;
    const tallied = collectProofs(entry.proofs, "amount", "secret");
    amount += tallied.amount;
    proofs += tallied.count;
    secrets.push(...tallied.secrets);
  }
  if (!proofs) return null;

  return {
    version: 3,
    amount,
    unit: typeof json.unit === "string" && json.unit ? json.unit : "sat",
    mint,
    memo: typeof json.memo === "string" && json.memo ? json.memo : undefined,
    proofs,
    secrets,
  };
}

function parseV4(payload: string): CashuTokenInfo | null {
  const bytes = base64urlToBytes(payload);
  if (!bytes) return null;
  let decoded: CborValue;
  try {
    decoded = decodeCbor(bytes);
  } catch {
    return null;
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.t)) return null;

  let amount = 0;
  let proofs = 0;
  const secrets: string[] = [];
  for (const entry of decoded.t) {
    if (!isRecord(entry)) continue;
    const tallied = collectProofs(entry.p, "a", "s");
    amount += tallied.amount;
    proofs += tallied.count;
    secrets.push(...tallied.secrets);
  }
  if (!proofs) return null;

  return {
    version: 4,
    amount,
    unit: typeof decoded.u === "string" && decoded.u ? decoded.u : "sat",
    mint: typeof decoded.m === "string" ? decoded.m : "",
    memo: typeof decoded.d === "string" && decoded.d ? decoded.d : undefined,
    proofs,
    secrets,
  };
}

/** Parse a serialized Cashu token; null means render as plain text. */
export function parseCashuToken(raw: string): CashuTokenInfo | null {
  const token = raw.startsWith("cashu:") ? raw.slice("cashu:".length) : raw;
  if (!token.startsWith("cashu")) return null;
  const version = token[5];
  const payload = token.slice(6);
  if (!payload) return null;
  if (version === "A") return parseV3(payload);
  if (version === "B") return parseV4(payload);
  return null;
}

/** Strip a `cashu:` scheme so the raw token is what gets copied. */
export function stripCashuScheme(raw: string): string {
  return raw.startsWith("cashu:") ? raw.slice("cashu:".length) : raw;
}

/** Host of the mint URL, for compact display. Falls back to the raw string. */
export function cashuMintLabel(mint: string): string {
  if (!mint) return "unknown mint";
  try {
    return new URL(mint).host;
  } catch {
    return mint;
  }
}

/** secp256k1 field prime. */
const FIELD_P = 2n ** 256n - 2n ** 32n - 977n;

/** NUT-00 `hash_to_curve` domain separator. */
const DOMAIN_SEPARATOR = new TextEncoder().encode("Secp256k1_HashToCurve_Cashu_");

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/**
 * NUT-00 `hash_to_curve`: `Y = PublicKey('02' || SHA256(msg_hash || counter))`,
 * `msg_hash = SHA256(DOMAIN_SEPARATOR || x)`, little-endian uint32 counter.
 * Checks candidates via Euler's criterion on `X³ + 7` (p ≡ 3 mod 4) instead of
 * a curve library. Returns the hex compressed point.
 */
export function hashToCurve(message: Uint8Array): string {
  const msgHash = sha256(concatBytes(DOMAIN_SEPARATOR, message));
  const counter = new Uint8Array(4);
  const counterView = new DataView(counter.buffer);

  for (let i = 0; i < 0x10000; i++) {
    counterView.setUint32(0, i, true);
    const candidate = sha256(concatBytes(msgHash, counter));
    const x = BigInt(`0x${bytesToHex(candidate)}`);
    if (x === 0n || x >= FIELD_P) continue;
    const ySquared = (((x * x) % FIELD_P) * x + 7n) % FIELD_P;
    if (modPow(ySquared, (FIELD_P - 1n) / 2n, FIELD_P) === 1n) {
      return `02${bytesToHex(candidate)}`;
    }
  }
  throw new Error("hash_to_curve: no valid point found");
}

/** Spend state of a token, per NUT-07. */
export type CashuTokenState = "unspent" | "pending" | "spent";

/**
 * Ask the mint whether a token's proofs are spendable (NUT-07). Reveals interest
 * to an attacker-supplied mint, so only run on explicit user action. Null on failure.
 */
export async function checkCashuTokenState(
  info: CashuTokenInfo,
  signal?: AbortSignal,
): Promise<CashuTokenState | null> {
  if (!info.secrets.length) return null;

  let endpoint: URL;
  try {
    endpoint = new URL("/v1/checkstate", info.mint);
  } catch {
    return null;
  }
  // https only: the URL is attacker-supplied.
  if (endpoint.protocol !== "https:") return null;

  let states: unknown;
  try {
    // Wallets hash the secret's UTF-8 bytes, whatever the secret's own format.
    const encoder = new TextEncoder();
    const Ys = info.secrets.map((secret) => hashToCurve(encoder.encode(secret)));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Ys }),
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.states)) return null;
    states = body.states;
  } catch {
    return null;
  }

  const values = (states as unknown[])
    .map((entry) => (isRecord(entry) && typeof entry.state === "string" ? entry.state : null))
    .filter((state): state is string => state !== null);
  if (!values.length) return null;

  // Claimable if anything is unspent; pending if mid-flight.
  if (values.some((state) => state === "UNSPENT")) return "unspent";
  if (values.every((state) => state === "SPENT")) return "spent";
  return "pending";
}

export function formatCashuAmount(amount: number, unit: string): string {
  if (unit === "sat") return `${amount.toLocaleString()} sat`;
  if (unit === "msat") return `${amount.toLocaleString()} msat`;
  if (unit === "usd" || unit === "eur") {
    // Fiat units are denominated in cents.
    const symbol = unit === "usd" ? "$" : "€";
    return `${symbol}${(amount / 100).toFixed(2)}`;
  }
  return `${amount.toLocaleString()} ${unit}`;
}

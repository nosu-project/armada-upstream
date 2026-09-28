/**
 * Lightweight mainnet Bitcoin address validation (P2PKH, P2SH, segwit v0,
 * P2TR) per BIP173/BIP350, mirroring `@scure/btc-signer` but keeping that
 * ~150 kB stack out of the entry bundle. The heavy stack re-decodes before any
 * funds move.
 */
import { base58check as createBase58check, bech32, bech32m } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';

const base58check = createBase58check(sha256);

/** Mainnet base58 version bytes (matches `@scure/btc-signer` NETWORK). */
const P2PKH_VERSION = 0x00;
const P2SH_VERSION = 0x05;

/** Mainnet bech32 HRP. */
const HRP = 'bc';

/** Validate a bech32/bech32m segwit address (v0 or v1/taproot, mainnet). */
function validateSegwitAddress(address: string): boolean {
  // Accept (like @scure/btc-signer) v0 with 20/32-byte programs and v1 with 32 bytes.
  type Bech32String = `${Lowercase<string>}1${string}`;

  // v0 uses bech32, v1+ bech32m (BIP350); the decoded version picks the variant.
  for (const [codec, validVersion] of [[bech32, 0], [bech32m, 1]] as const) {
    try {
      const { prefix, words } = codec.decode(address as Bech32String, 90);
      if (prefix !== HRP) continue;
      const version = words[0];
      if (version !== validVersion) continue;
      const program = codec.fromWords(words.slice(1));
      if (version === 0) return program.length === 20 || program.length === 32;
      return program.length === 32; // taproot
    } catch { /* ignore */ }
  }
  return false;
}

/** Validate a legacy base58check address (P2PKH / P2SH, mainnet). */
function validateBase58Address(address: string): boolean {
  try {
    const data = base58check.decode(address);
    if (data.length !== 21) return false;
    return data[0] === P2PKH_VERSION || data[0] === P2SH_VERSION;
  } catch {
    return false;
  }
}

/** Validate a mainnet Bitcoin address's format and checksum. */
export function validateBitcoinAddress(address: string): boolean {
  if (typeof address !== 'string' || !address) return false;

  // No trimming, like the heavy decoder; callers trim input.
  const lower = address.toLowerCase();
  if (lower.startsWith(`${HRP}1`)) {
    return validateSegwitAddress(address);
  }
  return validateBase58Address(address);
}

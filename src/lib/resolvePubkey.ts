import { nip19 } from "nostr-tools";

/**
 * Resolve a typed npub/nprofile/hex string to a hex pubkey, or undefined.
 *
 * Non-throwing by construction: the input is untrusted (a pasted string, a
 * route param), and `nip19.decode` throws on anything that isn't well-formed
 * bech32 — which at a render site takes the whole subtree down.
 */
export function resolvePubkey(input: string): string | undefined {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch {
    // not bech32
  }
  return undefined;
}

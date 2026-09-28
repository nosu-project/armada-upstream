import { nip19 } from "nostr-tools";

/** npub/nprofile/hex → hex pubkey, or undefined. Non-throwing: input is untrusted. */
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

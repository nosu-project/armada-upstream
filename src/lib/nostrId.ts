import { NSchema as n } from '@nostrify/nostrify';

/** Branded validated 32-byte Nostr id (pubkey or event id): 64-char lowercase hex. */
export type HexId = string & { readonly __brand: 'HexId' };

/**
 * Canonical validator for pubkeys and event ids (backed by Nostrify's
 * {@link NSchema.id}). Use at the parse layer for untrusted input: malformed hex
 * throws deep inside `nip19` and crashes the render subtree. See `@/lib/safeNip19`
 * for non-throwing encoders.
 */
export function isNostrId(value: unknown): value is HexId {
  return idSchema.safeParse(value).success;
}

const idSchema = n.id();

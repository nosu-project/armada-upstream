import { isNostrId } from '@/lib/nostrId';

/**
 * A NIP-01 coordinate (`<kind>:<pubkey>:<d-tag>`) with a validated pubkey, safe
 * to pass to `nip19.naddrEncode` or filters. `identifier` may be empty or contain `:`.
 */
export interface ParsedAddr {
  kind: number;
  pubkey: string;
  identifier: string;
}

/**
 * Parse a NIP-01 addressable-event coordinate (NIP-22 `A`, NIP-51/58/84/89 `a`
 * tags, …). Undefined unless the kind is finite and the pubkey passes
 * {@link isNostrId}. Validate here so renderers needn't re-check.
 */
export function parseAddr(value: string | undefined): ParsedAddr | undefined {
  if (!value) return undefined;
  const parts = value.split(':');
  if (parts.length < 3) return undefined;
  const kind = Number(parts[0]);
  if (!Number.isFinite(kind)) return undefined;
  const pubkey = parts[1];
  if (!isNostrId(pubkey)) return undefined;
  return { kind, pubkey, identifier: parts.slice(2).join(':') };
}

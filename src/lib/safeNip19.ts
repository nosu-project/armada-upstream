import { nip19 } from 'nostr-tools';
import type {
  AddressPointer,
  EventPointer,
  NAddr,
  NEvent,
  NPub,
} from 'nostr-tools/nip19';

import { isNostrId } from '@/lib/nostrId';

/**
 * Non-throwing `nip19.*Encode` wrappers for untrusted input: the encoders throw
 * on malformed hex and would crash the render subtree. For NostrEvent-based
 * encoding prefer `encodeEventAddress` from `@/lib/encodeEvent`.
 */

/** `nip19.npubEncode`, but returns `undefined` for non-hex input. */
export function tryNpubEncode(pubkey: string | null | undefined): NPub | undefined {
  if (!isNostrId(pubkey)) return undefined;
  return nip19.npubEncode(pubkey);
}

/** `nip19.neventEncode`, `undefined` for a bad `id`; a malformed `author` is dropped. */
export function tryNeventEncode(input: EventPointer): NEvent | undefined {
  if (!isNostrId(input.id)) return undefined;
  const author = isNostrId(input.author) ? input.author : undefined;
  return nip19.neventEncode({ ...input, author });
}

/** `nip19.naddrEncode`, `undefined` for a bad `pubkey`. `identifier` may be any string. */
export function tryNaddrEncode(input: AddressPointer): NAddr | undefined {
  if (!isNostrId(input.pubkey)) return undefined;
  return nip19.naddrEncode(input);
}

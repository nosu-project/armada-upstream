import type { NostrMetadata } from '@nostrify/nostrify';

/**
 * name → display_name → "Anonymous". Truncate via CSS, not here, so NIP-30
 * emoji shortcodes aren't broken.
 */
export function getDisplayName(
  metadata: NostrMetadata | undefined,
  _pubkey?: string,
): string {
  return metadata?.name || metadata?.display_name || 'Anonymous';
}

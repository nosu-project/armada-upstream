import type { NostrMetadata } from '@nostrify/nostrify';

/** Whether a user has a lud16 or lud06 lightning address. */
export function canZap(metadata: NostrMetadata | undefined): boolean {
  if (!metadata) return false;
  return !!(metadata.lud16 || metadata.lud06);
}

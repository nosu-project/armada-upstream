import type { NostrMetadata } from '@nostrify/nostrify';

import { t } from '@/i18n/intl';

/**
 * name → display_name → "Anonymous" (in the active language). Truncate via CSS, not here, so NIP-30
 * emoji shortcodes aren't broken.
 */
export function getDisplayName(
  metadata: NostrMetadata | undefined,
  _pubkey?: string,
): string {
  return metadata?.name || metadata?.display_name || t({ id: 'notification.anonymous', defaultMessage: 'Anonymous' });
}

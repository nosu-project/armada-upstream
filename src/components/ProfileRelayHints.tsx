import { useEffect } from 'react';

import { addProfileRelayHints } from '@/sync/profileSync';

/**
 * Registers relays as profile-fetch hints while mounted: member profiles often
 * live only on community relays (see `src/sync/profileSync.ts`).
 */
export function ProfileRelayHints({ relays }: { relays: string[] | undefined }) {
  const key = (relays ?? []).join(' ');
  useEffect(() => {
    if (!key) return;
    return addProfileRelayHints(key.split(' '));
  }, [key]);
  return null;
}

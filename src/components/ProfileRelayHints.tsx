import { useEffect } from 'react';

import { addProfileRelayHints } from '@/sync/profileSync';

/**
 * Register the given relays as profile-fetch hints for as long as this is
 * mounted. Render one inside a community/server view: member profiles often
 * live only on the community's own relays, which the pool's general routing
 * never asks — the profile sync topic queries hinted relays alongside the
 * general pass (see `src/sync/profileSync.ts`). Renders nothing.
 */
export function ProfileRelayHints({ relays }: { relays: string[] | undefined }) {
  const key = (relays ?? []).join(' ');
  useEffect(() => {
    if (!key) return;
    return addProfileRelayHints(key.split(' '));
  }, [key]);
  return null;
}

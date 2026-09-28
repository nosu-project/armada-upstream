import { useMemo } from "react";

import { useCommunityRumors } from "@/concord/hooks/useCommunityRumors";
import { timeTravelers, type TimeTraveler } from "@/concord/lib/timeTravelers";
import type { Channel, Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * Members whose messages are dated well ahead of the local clock (the moderation
 * panel's "time traveler" flag; see {@link timeTravelers}), from the shared
 * community rumor read. Excludes the reader, who can't act on their own clock.
 */
export function useTimeTravelers(
  community: Community | undefined,
  channels: Channel[],
  active = true,
): TimeTraveler[] {
  const { user } = useCurrentUser();
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channels]);
  const { byChannel } = useCommunityRumors(active ? community?.idHex : undefined, active ? channelIds : []);

  return useMemo(
    () => timeTravelers(byChannel, Date.now(), user?.pubkey ? { self: user.pubkey } : {}),
    [byChannel, user?.pubkey],
  );
}

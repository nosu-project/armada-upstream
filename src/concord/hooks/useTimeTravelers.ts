import { useMemo } from "react";

import { useCommunityRumors } from "@/concord/hooks/useCommunityRumors";
import { timeTravelers, type TimeTraveler } from "@/concord/lib/timeTravelers";
import type { Channel, Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * Members whose messages are dated well ahead of the local clock — surfaced in
 * the moderation panel as a playful "time traveler" flag (a wrong device clock,
 * almost always; see {@link timeTravelers}). Derived from the SAME shared
 * community rumor read the unread badges use, so it costs no extra store scan.
 *
 * The reader's own pubkey is excluded: a device flagging itself would just be
 * telling the user their own clock is off, which the panel row — framed as
 * "someone here" — can't act on.
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

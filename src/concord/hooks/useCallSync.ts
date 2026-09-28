import { useEffect, useMemo, useRef } from "react";

import { useCommunity, useCommunityEntry, useCommunityList } from "@/concord/hooks/useCommunityList";
import { useControlFold, useDissolved } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { banVerdictPostdatesMembership, decideCallSync } from "@/concord/lib/callSync";
import { channelsView } from "@/concord/lib/community";
import { kickVerdictPostdatesMembership } from "@/concord/lib/selfRemoval";
import type { ConcordVoiceContext } from "@/contexts/CallContext";
import { useCall } from "@/hooks/useCall";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { logSync } from "@/lib/syncLog";

/**
 * Keeps a connected Concord call in step with the live vault + Control fold
 * (CORD-07 §1/§7): REJOINS on an epoch/room roll, HANGS UP on ban, Guestbook
 * removal, vault removal, or channel loss. A kick rotates nothing, so this
 * hang-up is the ONLY thing that ends a kicked member's call.
 */
export function useCallSync(ctx: ConcordVoiceContext, onLeave: () => void): void {
  const { joinConcordCall } = useCall();
  const { user } = useCurrentUser();
  const { data: listData } = useCommunityList();
  const community = useCommunity(ctx.community.idHex);
  const entry = useCommunityEntry(ctx.community.idHex);
  const { data: folded } = useControlFold(community);
  const { coalesced } = useGuestbook(community);
  // Keyed on the join-time snapshot: the live `community` vanishes on dissolve, but the grave outlives it.
  const { data: dissolvedAtMs } = useDissolved(ctx.community);
  const channels = useMemo(() => (community ? channelsView(community, folded) : []), [community, folded]);
  const acted = useRef(false);

  useEffect(() => {
    if (acted.current) return;
    const decision = decideCallSync({
      snapshot: {
        channelIdHex: ctx.channel.idHex,
        epoch: ctx.channel.current.epoch,
        roomPk: ctx.channel.voice.room.pk,
      },
      listLoaded: Boolean(listData),
      community,
      folded,
      channels,
      selfBanned: banVerdictPostdatesMembership(folded, user?.pubkey, entry?.added_at),
      selfKicked: kickVerdictPostdatesMembership(
        user ? coalesced.get(user.pubkey) : undefined,
        user?.pubkey,
        folded?.ownerHex,
        entry?.added_at,
      ),
      dissolved: Boolean(dissolvedAtMs),
    });
    if (decision.action === "stay") return;
    acted.current = true;
    if (decision.action === "leave") {
      logSync("voice", `${ctx.community.idHex.slice(0, 8)} call sync: hanging up (${decision.reason})`);
      onLeave();
      return;
    }
    logSync(
      "voice",
      `${ctx.community.idHex.slice(0, 8)} call sync: epoch rolled — rejoining #${decision.channel.name} at epoch ${decision.channel.current.epoch}`,
    );
    // Keep the current broker; §5 migration re-runs in the remounted room.
    joinConcordCall({ community: decision.community, channel: decision.channel, broker: ctx.broker });
  }, [ctx, listData, community, folded, coalesced, channels, entry, user, dissolvedAtMs, onLeave, joinConcordCall]);
}

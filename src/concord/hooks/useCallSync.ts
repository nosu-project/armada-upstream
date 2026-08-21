import { useEffect, useMemo, useRef } from "react";

import { useCommunity, useCommunityEntry, useCommunityList } from "@/concord/hooks/useCommunityList";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { banVerdictPostdatesMembership, decideCallSync } from "@/concord/lib/callSync";
import { channelsView } from "@/concord/lib/community";
import { kickVerdictPostdatesMembership } from "@/concord/lib/selfRemoval";
import type { ConcordVoiceContext } from "@/contexts/CallContext";
import { useCall } from "@/hooks/useCall";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { logSync } from "@/lib/syncLog";

/**
 * Keeps a connected Concord call in lockstep with the live vault + Control
 * fold (CORD-07 §1/§7). The connected room is a join-time snapshot; this
 * watcher compares it against the community's LIVE state and:
 *
 *   - REJOINS at the fresh coordinates when the channel's epoch/room rolled
 *     (a Rekey/Refounding severs a removed member only if everyone else moves
 *     to the new room — `joinConcordCall` with the fresh channel remounts the
 *     connection via CallProvider's epoch-keyed remount);
 *   - HANGS UP when the folded Banlist or the coalesced Guestbook names this
 *     membership, when the vault entry is gone (left, or the compliant
 *     self-removal ran), or when the channel left the live view (deleted /
 *     rotated key withheld). A kick rotates nothing, so unlike a ban's
 *     Refounding this hang-up is the ONLY thing that ends a kicked member's
 *     call.
 *
 * Mounted by ConcordVoiceRoom, so it runs exactly while a call is connected —
 * app-level, independent of which page the user is on. One action per mount:
 * a rejoin remounts the room (a fresh watcher takes over) and a leave tears
 * it down.
 */
export function useCallSync(ctx: ConcordVoiceContext, onLeave: () => void): void {
  const { joinConcordCall } = useCall();
  const { user } = useCurrentUser();
  const { data: listData } = useCommunityList();
  const community = useCommunity(ctx.community.idHex);
  const entry = useCommunityEntry(ctx.community.idHex);
  const { data: folded } = useControlFold(community);
  const { coalesced } = useGuestbook(community);
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
    // Keep the current broker; the §5 rendezvous migration effect re-runs in
    // the remounted room if presence points somewhere better.
    joinConcordCall({ community: decision.community, channel: decision.channel, broker: ctx.broker });
  }, [ctx, listData, community, folded, coalesced, channels, entry, user, onLeave, joinConcordCall]);
}

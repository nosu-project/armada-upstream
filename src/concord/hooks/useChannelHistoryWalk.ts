import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { useJoinedCommunities } from "@/concord/hooks/useCommunityList";
import { dissolvedAt } from "@/concord/hooks/useControlPlane";
import { setChannelHistoryContext, type ChannelSyncContext } from "@/concord/lib/channelSync";
import { channelsView } from "@/concord/lib/community";
import { heldChannelKeys, rehydrateCommunity } from "@/concord/lib/communityList";
import { readControlFold } from "@/concord/lib/control";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import { onFoldedWrite } from "@/lib/foldedCache";
import { want } from "@/sync/syncManager";

import type { Channel, Community } from "@/concord/lib/types";

interface Walk {
  community: Community;
  channel: Channel;
}

/**
 * Changes when a channel's relays or held streams do, so its context is
 * re-registered. Includes each stream's retirement: a stale one would store
 * messages a retired key sealed after its rotation.
 */
function walkSig({ community, channel }: Walk): string {
  return `${community.relays.join(",")}|${channel.streams.map((s) => `${s.group.pk}:${s.retiredAt ?? ""}`).join(",")}`;
}

/**
 * Hold a background `c2hist:` want for every channel of every live community,
 * so each one's history is read down to the bottom without being opened —
 * local search is all there is (the content is end-to-end encrypted), and it
 * can only find what is on the device. The scheduler runs these one at a time,
 * behind anything visible, and only while the app is in the foreground.
 */
export function useChannelHistoryWalk(): void {
  const { nostr } = useNostr();
  const entries = useJoinedCommunities();
  const listSig = useMemo(
    () =>
      entries
        .map((e) => `${e.community_id}:${e.current.root_epoch}:${heldChannelKeys(e.current.channels).length}`)
        .sort()
        .join(","),
    [entries],
  );

  // A new channel or a rotated epoch lands as a fold snapshot.
  const queryClient = useQueryClient();
  useEffect(
    () =>
      onFoldedWrite((key) => {
        if (key.startsWith("concord2-fold:")) {
          void queryClient.invalidateQueries({ queryKey: ["concord", "history-walk"] });
        }
      }),
    [queryClient],
  );

  const { data: walks } = useQuery<Walk[]>({
    queryKey: ["concord", "history-walk", listSig],
    enabled: entries.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const out: Walk[] = [];
      for (const entry of entries) {
        const community = rehydrateCommunity(entry);
        if (!community || community.relays.length === 0) continue;
        if ((await dissolvedAt(community.idHex)) !== undefined) continue;
        const folded = await readControlFold(community.idHex);
        for (const channel of channelsView(community, folded)) {
          if (channel.streams.length > 0) out.push({ community, channel });
        }
      }
      return out;
    },
  });

  // Diffed by channel rather than torn down per result: releasing a want aborts
  // its in-flight round, and the query re-resolves on every fold write.
  const held = useRef(new Map<string, { sig: string; release: () => void; releaseCtx: () => void }>());
  useEffect(() => {
    const current = held.current;
    const next = new Set<string>();
    for (const walk of walks ?? []) {
      const id = walk.channel.idHex;
      next.add(id);
      const sig = walkSig(walk);
      const prev = current.get(id);
      if (prev?.sig === sig) continue;
      registerStreamKeys(walk.channel.streams.map((s) => s.group), walk.community.relays);
      const ctx: ChannelSyncContext = { nostr, community: walk.community, channel: walk.channel };
      const releaseCtx = setChannelHistoryContext(id, ctx);
      prev?.releaseCtx();
      current.set(id, { sig, releaseCtx, release: prev?.release ?? want(`c2hist:${id}`, "prefetch") });
    }
    for (const [id, entry] of current) {
      if (next.has(id)) continue;
      entry.release();
      entry.releaseCtx();
      current.delete(id);
    }
  }, [walks, nostr]);

  useEffect(() => {
    const current = held.current;
    return () => {
      for (const entry of current.values()) {
        entry.release();
        entry.releaseCtx();
      }
      current.clear();
    };
  }, []);
}

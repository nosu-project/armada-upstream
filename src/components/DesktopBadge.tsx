import { useEffect, useMemo, useRef, useState } from "react";

import { useCommunity, useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { useConcordUnread } from "@/concord/hooks/useConcordUnread";
import { useChannels } from "@/concord/hooks/useControlPlane";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutes } from "@/hooks/useMutes";
import { useRelayUnread } from "@/hooks/useRelayUnread";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { isDesktop, setDesktopBadge } from "@/lib/desktop";

/** Reports total unread/mention count to the desktop shell for the tray/OS badge. No-op on web. */
export function DesktopBadge() {
  const { user } = useCurrentUser();
  const { data: groupList } = useUserGroupList();
  const communities = useLiveCommunities();

  const byRelay = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const g of groupList?.groups ?? []) {
      const arr = map.get(g.relay) ?? [];
      arr.push(g.id);
      map.set(g.relay, arr);
    }
    return map;
  }, [groupList]);

  const [counts, setCounts] = useState<Record<string, number>>({});

  const report = (relay: string, count: number) => {
    setCounts((prev) => (prev[relay] === count ? prev : { ...prev, [relay]: count }));
  };

  const total = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );
  const lastSent = useRef<number>(-1);
  useEffect(() => {
    if (!isDesktop()) return;
    if (lastSent.current === total) return;
    lastSent.current = total;
    setDesktopBadge(total);
  }, [total]);

  if (!isDesktop() || !user) return null;

  return (
    <>
      {[...byRelay.entries()].map(([relay, groupIds]) => (
        <RelayUnreadCounter
          key={relay}
          relay={relay}
          groupIds={groupIds}
          onCount={(n) => report(relay, n)}
        />
      ))}
      {communities.map((c) => (
        <ConcordUnreadCounter
          key={`c2:${c.community_id}`}
          communityId={c.community_id}
          onCount={(n) => report(`c2:${c.community_id}`, n)}
        />
      ))}
    </>
  );
}

function ConcordUnreadCounter({
  communityId,
  onCount,
}: {
  communityId: string;
  onCount: (count: number) => void;
}) {
  const community = useCommunity(communityId);
  const channels = useChannels(community, false);
  const { byChannel } = useConcordUnread(community, channels);
  const { isConcordChannelMuted } = useMutes();
  // Mirror the rail: a muted channel doesn't count unless it holds a mention.
  const count = Object.entries(byChannel).filter(
    ([id, u]) => u.mention || !isConcordChannelMuted("c2", communityId, id),
  ).length;
  useEffect(() => {
    onCount(count);
  }, [count, onCount]);
  return null;
}

function RelayUnreadCounter({
  relay,
  groupIds,
  onCount,
}: {
  relay: string;
  groupIds: string[];
  onCount: (count: number) => void;
}) {
  const { byGroup } = useRelayUnread(relay, groupIds);
  const { isChannelMuted } = useMutes();
  // Muted channels don't count unless they hold a mention.
  const count = Object.entries(byGroup).filter(
    ([id, g]) => g.mention || !isChannelMuted(relay, id),
  ).length;
  useEffect(() => {
    onCount(count);
  }, [count, onCount]);
  return null;
}

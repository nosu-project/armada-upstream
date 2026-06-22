import { useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRelayUnread } from "@/hooks/useRelayUnread";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { isDesktop, setDesktopBadge } from "@/lib/desktop";

/**
 * Reports the user's total unread/mention count to the desktop shell so it can
 * show a tray / OS badge. Renders nothing, and does nothing on the web (the
 * desktop bridge is absent).
 *
 * Reuses the same per-relay unread computation the server rail uses. One child
 * subscribes per server (each `useRelayUnread` opens a single REQ); the parent
 * sums the per-server counts and pushes the total through the bridge.
 */
export function DesktopBadge() {
  const { user } = useCurrentUser();
  const { data: groupList } = useUserGroupList();

  // Group the user's joined groups by their host relay.
  const byRelay = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const g of groupList?.groups ?? []) {
      const arr = map.get(g.relay) ?? [];
      arr.push(g.id);
      map.set(g.relay, arr);
    }
    return map;
  }, [groupList]);

  // Per-relay counts, keyed by relay url.
  const [counts, setCounts] = useState<Record<string, number>>({});

  const report = (relay: string, count: number) => {
    setCounts((prev) => (prev[relay] === count ? prev : { ...prev, [relay]: count }));
  };

  // Sum and push to the desktop shell whenever it changes.
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
    </>
  );
}

/** Subscribes to one relay's unread and reports the count of unread groups. */
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
  const count = Object.keys(byGroup).length;
  useEffect(() => {
    onCount(count);
  }, [count, onCount]);
  return null;
}

import { useCallback, useMemo } from "react";

import { isEntitled } from "@/concord/lib/channelAccess";
import type { CommunityRoles } from "@/concord/lib/roles";

interface ScopeChannel {
  idHex: string;
  isPrivate: boolean;
}

/**
 * The member panel's private-channel scoping (CORD-03): only the channel actually
 * open scopes it. Outside a channel view the page's `channel` is the last-viewed
 * one, which must not narrow panes like "All Messages".
 */
export function useMemberPanelScope<C extends ScopeChannel>({
  view,
  channel,
  roster,
  ownerHex,
  memberPubkeys,
  channelRoleCatalog,
  roleCatalog,
}: {
  view: string;
  channel: C | undefined;
  roster: CommunityRoles | undefined;
  ownerHex: string | undefined;
  memberPubkeys: string[];
  channelRoleCatalog: Map<string, Array<{ id: string; name: string }>>;
  roleCatalog: Array<{ id: string; assignable: boolean }> | undefined;
}) {
  const panelChannel = view === "channel" ? channel : undefined;

  const entitledHere = useCallback(
    (pk: string) => !panelChannel?.isPrivate || isEntitled(roster, ownerHex, pk, panelChannel.idHex),
    [panelChannel, roster, ownerHex],
  );

  // "Add members" = grant a scoped Role (vends the key); offered only for roles the
  // viewer outranks.
  const addableChannelRoles = useMemo(() => {
    if (!panelChannel?.isPrivate) return [];
    const assignable = new Set((roleCatalog ?? []).filter((r) => r.assignable).map((r) => r.id));
    return (channelRoleCatalog.get(panelChannel.idHex) ?? []).filter((r) => assignable.has(r.id));
  }, [panelChannel, channelRoleCatalog, roleCatalog]);

  const addMemberCandidates = useMemo(
    () => (panelChannel?.isPrivate ? memberPubkeys.filter((pk) => !entitledHere(pk)) : []),
    [panelChannel, memberPubkeys, entitledHere],
  );

  return { panelChannel, entitledHere, addableChannelRoles, addMemberCandidates };
}

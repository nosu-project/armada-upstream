// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CommunityRoles, Role } from "@/concord/lib/roles";

import { useMemberPanelScope } from "./useMemberPanelScope";

const OWNER = "f".repeat(64);
const HOLDER = "1".repeat(64);
const OUTSIDER = "2".repeat(64);

const CH_SECRET = "aa".repeat(32);
const CH_OPEN = "bb".repeat(32);

const ROLE_TESTER = "a".repeat(64); // scoped to CH_SECRET, assignable by the viewer
const ROLE_AUDIT = "b".repeat(64); // scoped to CH_SECRET, outranks the viewer

const role = (roleId: string, name: string, position: number, scope: Role["scope"]): Role => ({
  roleId,
  name,
  position,
  permissions: 0n,
  scope,
  color: 0,
});

const roster: CommunityRoles = {
  roles: [
    role(ROLE_TESTER, "Tester", 5, { kind: "channel", channelId: CH_SECRET }),
    role(ROLE_AUDIT, "Auditor", 4, { kind: "channel", channelId: CH_SECRET }),
  ],
  grants: [{ member: HOLDER, roleIds: [ROLE_TESTER] }],
};

const channelRoleCatalog = new Map([
  [CH_SECRET, [{ id: ROLE_AUDIT, name: "Auditor" }, { id: ROLE_TESTER, name: "Tester" }]],
]);
const roleCatalog = [
  { id: ROLE_TESTER, assignable: true },
  { id: ROLE_AUDIT, assignable: false },
];
const memberPubkeys = [OWNER, HOLDER, OUTSIDER];

const secret = { idHex: CH_SECRET, isPrivate: true, name: "secret" };
const open = { idHex: CH_OPEN, isPrivate: false, name: "general" };

type Props = { view: string; channel: typeof secret | undefined };

function render(initial: Props) {
  return renderHook(
    ({ view, channel }: Props) =>
      useMemberPanelScope({ view, channel, roster, ownerHex: OWNER, memberPubkeys, channelRoleCatalog, roleCatalog }),
    { initialProps: initial },
  );
}

describe("useMemberPanelScope", () => {
  it("scopes the panel to an open private channel's key holders (CORD-03)", () => {
    const { result } = render({ view: "channel", channel: secret });
    expect(result.current.panelChannel).toBe(secret);
    expect(memberPubkeys.filter(result.current.entitledHere)).toEqual([OWNER, HOLDER]);
    expect(result.current.addMemberCandidates).toEqual([OUTSIDER]);
    // Only the scoped roles the viewer outranks.
    expect(result.current.addableChannelRoles).toEqual([{ id: ROLE_TESTER, name: "Tester" }]);
  });

  it("leaves a public channel's panel unscoped", () => {
    const { result } = render({ view: "channel", channel: open });
    expect(memberPubkeys.filter(result.current.entitledHere)).toEqual(memberPubkeys);
    expect(result.current.addMemberCandidates).toEqual([]);
    expect(result.current.addableChannelRoles).toEqual([]);
  });

  it("does not scope a pane by the last-viewed private channel", () => {
    const { result } = render({ view: "all", channel: secret });
    expect(result.current.panelChannel).toBeUndefined();
    expect(memberPubkeys.filter(result.current.entitledHere)).toEqual(memberPubkeys);
    expect(result.current.addMemberCandidates).toEqual([]);
    expect(result.current.addableChannelRoles).toEqual([]);
  });

  it("drops and restores the scope across channel -> pane -> channel", () => {
    const { result, rerender } = render({ view: "channel", channel: secret });
    expect(result.current.panelChannel?.idHex).toBe(CH_SECRET);

    rerender({ view: "all", channel: secret });
    // The page closes the Add Members dialog on this id changing.
    expect(result.current.panelChannel?.idHex).toBeUndefined();
    expect(memberPubkeys.filter(result.current.entitledHere)).toEqual(memberPubkeys);

    rerender({ view: "channel", channel: secret });
    expect(result.current.panelChannel?.idHex).toBe(CH_SECRET);
    expect(memberPubkeys.filter(result.current.entitledHere)).toEqual([OWNER, HOLDER]);
  });

  it("keeps entitledHere's identity while the scope is unchanged", () => {
    const { result, rerender } = render({ view: "channel", channel: secret });
    const first = result.current.entitledHere;
    rerender({ view: "channel", channel: secret });
    expect(result.current.entitledHere).toBe(first);

    // On a pane the last-viewed channel no longer feeds the panel at all.
    rerender({ view: "all", channel: secret });
    const onPane = result.current.entitledHere;
    rerender({ view: "all", channel: open });
    expect(result.current.entitledHere).toBe(onPane);
  });
});

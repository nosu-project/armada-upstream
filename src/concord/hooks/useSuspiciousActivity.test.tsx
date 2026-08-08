/**
 * The watchdog's gating: what a short read forbids, and what it must NOT.
 *
 * A flood is the loudest evidence there is that something is wrong, so it has
 * to raise the alarm rather than switch it off. What it genuinely forbids is
 * NAMING someone: under a short read "roleless" and "we haven't reached their
 * grant yet" look identical, and this alert is one click from banning them.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FoldedControl } from "@/concord/lib/control";
import { Permissions, type CommunityRoles } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";

const ME = "a".repeat(64);
const OWNER = "0".repeat(64);
const JIM = "b".repeat(64);

const h = vi.hoisted(() => ({
  answered: true,
  truncated: false,
  quorum: true,
  unreadable: 0,
  /** Actors the (already unit-tested) detector would return for this fold. */
  detected: [{ author: "b".repeat(64), attempts: new Map(), total: 3, firstAt: 1, lastAt: 2, banned: false }],
}));

vi.mock("@/concord/lib/planeSync", () => ({
  controlSweepAnswered: () => h.answered,
  controlSweepTruncated: () => h.truncated,
  controlSweepQuorum: () => h.quorum,
  controlSweepUnreadable: () => h.unreadable,
  subscribeSweepVerdicts: () => () => undefined,
  sweepVerdictRevision: () => 0,
}));
vi.mock("@/concord/lib/auditLog", () => ({ suspiciousActivity: () => h.detected }));
vi.mock("@/concord/lib/control", () => ({ openControlEditions: () => [] }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlEvents: () => ({ data: [] as unknown[] }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: ME } }) }));

const { useSuspiciousActivity } = await import("@/concord/hooks/useSuspiciousActivity");

/** A roster where ME can ban, so the watchdog reports at all. */
const roster: CommunityRoles = {
  roles: [
    { roleId: "r1", name: "Admin", position: 1, permissions: Permissions.BAN, scope: { kind: "server" }, color: 0 },
  ],
  grants: [{ member: ME, roleIds: ["r1"] }],
};

const community = { idHex: "cc".repeat(32), id: new Uint8Array(32), relays: [] } as unknown as Community;
const folded = { roster, ownerHex: OWNER, banned: new Set<string>() } as unknown as FoldedControl;

const render = () => renderHook(() => useSuspiciousActivity(community, folded));

beforeEach(() => {
  h.answered = true;
  h.truncated = false;
  h.quorum = true;
  h.unreadable = 0;
  localStorage.clear();
});

describe("useSuspiciousActivity gating", () => {
  it("names an actor off a clean read", async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.actors.map((a) => a.author)).toEqual([JIM]));
    expect(result.current.alert).toBe(true);
  });

  it("STILL raises the alarm on a short read, without naming anyone", async () => {
    // The hole this guards: gating the whole watchdog on a clean read let the
    // flood switch off the alert that describes it — the disclosed deadlock,
    // reappearing one layer up.
    h.truncated = true;
    const { result } = render();
    await waitFor(() => expect(result.current.flooded).toBe(true));
    expect(result.current.alert, "a flood must be reported").toBe(true);
    expect(result.current.actors, "but nobody may be accused off a partial read").toEqual([]);
  });

  it("does not name anyone when too few relays answered", async () => {
    // A grant published to one relay and read by a client that reached another
    // makes an honest admin look like an intruder.
    h.quorum = false;
    const { result } = render();
    await waitFor(() => expect(result.current.actors).toEqual([]));
    expect(result.current.alert).toBe(false);
  });

  it("reports nothing at all until some relay has answered", async () => {
    h.answered = false;
    const { result } = render();
    await waitFor(() => expect(result.current.alert).toBe(false));
    expect(result.current.flooded).toBe(false);
  });

  it("a dismissed flood stays quiet, and speaks again if it clears and returns", async () => {
    h.truncated = true;
    h.detected = [];
    const first = render();
    await waitFor(() => expect(first.result.current.alert).toBe(true));
    first.result.current.dismiss();
    await waitFor(() => expect(first.result.current.alert).toBe(false));

    // The flood clears: the watermark must ratchet back down…
    h.truncated = false;
    const cleared = render();
    await waitFor(() => expect(cleared.result.current.flooded).toBe(false));

    // …so a NEW flood is heard rather than swallowed by the old dismissal.
    h.truncated = true;
    const again = render();
    await waitFor(() => expect(again.result.current.alert, "a fresh flood must speak up").toBe(true));
  });
});

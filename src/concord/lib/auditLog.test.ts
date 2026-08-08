/**
 * Audit classification and the suspicious-activity watchdog.
 */

import { describe, expect, it } from "vitest";

import {
  INVITE_ALERT_THRESHOLD,
  UNRECOGNISED_BURST,
  classifyEditions,
  describeAttempts,
  suspiciousActivity,
} from "@/concord/lib/auditLog";
import type { FoldedControl } from "@/concord/lib/control";
import type { ParsedEdition } from "@/concord/lib/edition";
import { bytesToHex, grantLocator, hex32 } from "@/concord/lib/derive";
import { VSK_BANLIST, VSK_CHANNEL, VSK_GRANT, VSK_INVITE_REGISTRY, VSK_METADATA, VSK_ROLE } from "@/concord/lib/kinds";
import { Permissions, type CommunityRoles } from "@/concord/lib/roles";

const CID = new Uint8Array(32).fill(0xc1);
const OWNER = "0".repeat(64);
const ADMIN = "a".repeat(64);
const JIM = "b".repeat(64);

const bytes = (fill: number) => new Uint8Array(32).fill(fill);

function edition(over: Partial<ParsedEdition> & { rumorId: Uint8Array }): ParsedEdition {
  return {
    author: JIM,
    vsk: VSK_CHANNEL,
    entityId: bytes(0x11),
    version: 1n,
    content: "{}",
    selfHash: over.rumorId,
    createdAt: 1_000,
    opened: undefined as unknown as ParsedEdition["opened"],
    ...over,
  };
}

/** An opened control event that is NOT a parseable edition (semi-junk). */
function openedAt(author: string, createdAt: number) {
  return {
    rumorId: `${author.slice(0, 8)}-${createdAt}`,
    author,
    kind: 41234,
    content: "{}",
    tags: [],
    ms: createdAt * 1000,
    createdAt,
    wrapId: "w",
    streamPk: "s",
  } as unknown as Parameters<typeof suspiciousActivity>[2] extends { opened?: readonly (infer T)[] } ? T : never;
}

/** A roster where ADMIN holds every permission and nobody else does. */
const roster: CommunityRoles = {
  roles: [
    {
      roleId: "r1",
      name: "Admin",
      position: 1,
      permissions:
        Permissions.MANAGE_METADATA | Permissions.MANAGE_CHANNELS | Permissions.MANAGE_ROLES | Permissions.BAN,
      scope: { kind: "server" },
      color: 0,
    },
  ],
  grants: [{ member: ADMIN, roleIds: ["r1"] }],
};

function fold(over: Partial<FoldedControl> = {}): FoldedControl {
  return {
    roster,
    ownerHex: OWNER,
    channels: new Map(),
    banned: new Set<string>(),
    bannedAt: new Map<string, number>(),
    liveInviteLinks: new Set<string>(),
    registriesByCreator: new Map(),
    heads: new Map(),
    headEditions: new Map(),
    incomplete: [],
    ...over,
  } as FoldedControl;
}

/**
 * A fold where JIM's roles were stripped at `at` — an empty grant row plus the
 * grant edition that produced it, which is what dates the demotion.
 */
function demotedAt(at: number): FoldedControl {
  const eid = grantLocator(CID, hex32(JIM));
  return {
    ...fold(),
    roster: { roles: [], grants: [{ member: JIM, roleIds: [] }] },
    headEditions: new Map([
      [bytesToHex(eid), edition({ rumorId: bytes(0x99), author: ADMIN, vsk: VSK_GRANT, entityId: eid, createdAt: at })],
    ]),
  } as FoldedControl;
}

describe("classifyEditions", () => {
  it("marks the head current, its chained ancestor superseded, and a plant dropped", () => {
    const v1 = edition({ rumorId: bytes(0x01), version: 1n });
    const v2 = edition({ rumorId: bytes(0x02), version: 2n, prevHash: v1.selfHash });
    const plant = edition({ rumorId: bytes(0x03), version: 9n });

    const verdicts = classifyEditions(
      [v1, v2, plant],
      fold({ headEditions: new Map([["11".repeat(32), v2]]) }),
    );

    expect(verdicts.get("02".repeat(32))).toBe("current");
    expect(verdicts.get("01".repeat(32))).toBe("superseded");
    expect(verdicts.get("03".repeat(32)), "a high version off the chain was never honored").toBe("dropped");
  });

  it("says unknown, never dropped, when there is no fold to judge against", () => {
    const verdicts = classifyEditions([edition({ rumorId: bytes(0x01) })], undefined);
    expect(verdicts.get("01".repeat(32))).toBe("unknown");
  });
});

describe("suspiciousActivity", () => {
  it("flags a roleless member writing control editions, counted by kind", () => {
    const editions = [
      edition({ rumorId: bytes(0x01), vsk: VSK_BANLIST }),
      edition({ rumorId: bytes(0x02), vsk: VSK_BANLIST }),
      edition({ rumorId: bytes(0x03), vsk: VSK_CHANNEL }),
    ];
    const [actor, ...rest] = suspiciousActivity(editions, fold(), CID);

    expect(rest).toHaveLength(0);
    expect(actor.author).toBe(JIM);
    expect(actor.total).toBe(3);
    expect(actor.attempts.get(VSK_BANLIST)).toBe(2);
    expect(describeAttempts(actor.attempts)).toBe("2 bans, 1 channel change");
  });

  it("ignores an AUTHORISED author whose edition merely lost a fork", () => {
    // `dropped` also covers fork losers. An admin loses a race often enough
    // that alerting on it would cry wolf — the question is standing, not luck.
    const editions = [edition({ rumorId: bytes(0x01), author: ADMIN, vsk: VSK_METADATA })];
    expect(suspiciousActivity(editions, fold(), CID)).toEqual([]);
  });

  it("ignores the owner, whose rank comes from the community id", () => {
    const editions = [edition({ rumorId: bytes(0x01), author: OWNER, vsk: VSK_BANLIST })];
    expect(suspiciousActivity(editions, fold(), CID)).toEqual([]);
  });

  it("only counts editions newer than the watermark", () => {
    // The fold judges by CURRENT authority, so a demotion turns an ex-admin's
    // whole back catalogue unauthorized. Without `since` that lights up as an
    // attack the moment anyone is demoted.
    const editions = [
      edition({ rumorId: bytes(0x01), createdAt: 500 }),
      edition({ rumorId: bytes(0x02), createdAt: 1_500 }),
    ];
    const actors = suspiciousActivity(editions, fold(), CID, { since: 1_000 });
    expect(actors).toHaveLength(1);
    expect(actors[0].total, "only the edition after the watermark counts").toBe(1);
  });

  it("flags a banned author with no grant", () => {
    const editions = [edition({ rumorId: bytes(0x01), author: JIM, vsk: VSK_BANLIST })];
    const actors = suspiciousActivity(editions, fold({ banned: new Set([JIM]) }), CID);
    expect(actors).toHaveLength(1);
    expect(actors[0].banned).toBe(true);
  });

  it("still flags a BANNED member, whose ban left them an empty grant row", () => {
    // Banning strips roles, and a strip is published as `{ member, roleIds: [] }`
    // — a grant row. If the grant skip outranked the ban, every banned member
    // would be invisible to the watchdog, which is precisely the population
    // most likely to be abusing the plane key they still hold.
    const stripped = {
      ...fold({ banned: new Set([JIM]) }),
      roster: { roles: [], grants: [{ member: JIM, roleIds: [] }] },
    } as FoldedControl;
    const editions = [edition({ rumorId: bytes(0x01), author: JIM, vsk: VSK_BANLIST })];
    const actors = suspiciousActivity(editions, stripped, CID);
    expect(actors).toHaveLength(1);
    expect(actors[0].banned).toBe(true);
  });

  it("never denounces the owner, even when a moderator has banlisted them", () => {
    // `folded.banned` can contain the owner. Without an owner check first, the
    // banned branch short-circuits their authority exemption and the alert
    // tells every admin the owner is attacking the community.
    const editions = [edition({ rumorId: bytes(0x01), author: OWNER, vsk: VSK_BANLIST })];
    expect(suspiciousActivity(editions, fold({ banned: new Set([OWNER]) }), CID)).toEqual([]);
  });

  it("does not flag a DEMOTED admin's back catalogue", () => {
    // Authority is judged as it stands today, so a demotion retroactively makes
    // everything they ever published unauthorized. Anchoring on WHEN their
    // standing changed keeps their pre-demotion work out of the alert.
    const editions = [
      edition({ rumorId: bytes(0x01), author: JIM, vsk: VSK_CHANNEL, createdAt: 1_000 }),
      edition({ rumorId: bytes(0x02), author: JIM, vsk: VSK_BANLIST, createdAt: 1_100 }),
    ];
    expect(suspiciousActivity(editions, demotedAt(2_000), CID)).toEqual([]);
  });

  it("DOES flag what a demoted admin publishes after the demotion", () => {
    // The other half of the same rule. An empty grant row is permanent, so
    // exempting anyone who holds one made every kicked and demoted member —
    // the population that still holds the plane key and has a grievance —
    // invisible to this alert forever.
    const editions = [
      edition({ rumorId: bytes(0x01), author: JIM, vsk: VSK_CHANNEL, createdAt: 1_000 }),
      edition({ rumorId: bytes(0x02), author: JIM, vsk: VSK_BANLIST, createdAt: 3_000 }),
      edition({ rumorId: bytes(0x03), author: JIM, vsk: VSK_BANLIST, createdAt: 3_100 }),
    ];
    const [actor, ...rest] = suspiciousActivity(editions, demotedAt(2_000), CID);
    expect(rest).toHaveLength(0);
    expect(actor.total, "only the post-demotion editions count").toBe(2);
    expect(actor.attempts.get(VSK_BANLIST)).toBe(2);
  });

  it("does not flag an unrecognised burst that predates the demotion", () => {
    const opened = Array.from({ length: UNRECOGNISED_BURST }, (_, i) => openedAt(JIM, 1_000 + i));
    expect(suspiciousActivity([], demotedAt(2_000), CID, { opened })).toEqual([]);
  });

  it("does not flag what a member published BEFORE they were banned", () => {
    // A ban is often the END of a legitimate admin's tenure, not proof their
    // whole back catalogue was an attack.
    const editions = [
      edition({ rumorId: bytes(0x01), author: JIM, vsk: VSK_BANLIST, createdAt: 1_000 }),
      edition({ rumorId: bytes(0x02), author: JIM, vsk: VSK_BANLIST, createdAt: 3_000 }),
    ];
    const banned = fold({ banned: new Set([JIM]), bannedAt: new Map([[JIM, 2_000]]) });
    const [actor, ...rest] = suspiciousActivity(editions, banned, CID);
    expect(rest).toHaveLength(0);
    expect(actor.total, "only what they published while already banned counts").toBe(1);
    expect(actor.banned).toBe(true);
  });

  it("does not flag a moderator whose ROLE was narrowed under them", () => {
    // Standing moves through three entities, not one. Editing a role's
    // permission mask strips everyone holding it without touching any grant
    // row, so anchoring on grants alone denounces an honest moderator the
    // moment an owner tightens their role.
    const roleId = "1e".repeat(32);
    const narrowed = {
      ...fold(),
      roster: {
        roles: [{ roleId, name: "Mod", position: 1, permissions: 0n, scope: { kind: "server" }, color: 0 }],
        grants: [{ member: JIM, roleIds: [roleId] }],
      },
      headEditions: new Map([
        [roleId, edition({ rumorId: bytes(0x98), author: OWNER, vsk: VSK_ROLE, createdAt: 2_000 })],
      ]),
    } as unknown as FoldedControl;
    const editions = [edition({ rumorId: bytes(0x01), author: JIM, vsk: VSK_CHANNEL, createdAt: 1_000 })];
    expect(suspiciousActivity(editions, narrowed, CID)).toEqual([]);
  });

  it("counts unrecognised events against someone already flagged", () => {
    // Semi-junk: it decrypted, so the seal names the signer, but it is not an
    // edition we understand. Attributed, not dumped in the anonymous pile.
    const editions = [edition({ rumorId: bytes(0x01), vsk: VSK_BANLIST })];
    const opened = [openedAt(JIM, 2_000), openedAt(JIM, 2_001)];
    const [actor] = suspiciousActivity(editions, fold(), CID, { opened });

    expect(actor.attempts.get("unrecognised")).toBe(2);
    expect(describeAttempts(actor.attempts)).toBe("1 ban, 2 unrecognised events");
  });

  it("does NOT flag unrecognised events alone below the burst rate", () => {
    // A client newer than this one publishing a kind we predate looks exactly
    // like semi-junk. Rate is what separates them, so a trickle stays quiet.
    const opened = Array.from({ length: UNRECOGNISED_BURST - 1 }, (_, i) => openedAt(JIM, 2_000 + i));
    expect(suspiciousActivity([], fold(), CID, { opened })).toEqual([]);
  });

  it("flags a BURST of unrecognised events from someone otherwise clean", () => {
    const opened = Array.from({ length: UNRECOGNISED_BURST }, (_, i) => openedAt(JIM, 2_000 + i));
    const [actor, ...rest] = suspiciousActivity([], fold(), CID, { opened });
    expect(rest).toHaveLength(0);
    expect(actor.author).toBe(JIM);
    expect(actor.total).toBe(UNRECOGNISED_BURST);
  });

  it("does not call the same volume spread beyond the window a burst", () => {
    // Same count, one per minute: sustained but not a burst.
    const opened = Array.from({ length: UNRECOGNISED_BURST }, (_, i) => openedAt(JIM, 2_000 + i * 60));
    expect(suspiciousActivity([], fold(), CID, { opened })).toEqual([]);
  });

  it("never flags the owner on unrecognised events", () => {
    const opened = Array.from({ length: UNRECOGNISED_BURST * 2 }, (_, i) => openedAt(OWNER, 2_000 + i));
    expect(suspiciousActivity([], fold(), CID, { opened })).toEqual([]);
  });

  it("ranks the busiest actor first", () => {
    const editions = [
      edition({ rumorId: bytes(0x01), author: JIM }),
      edition({ rumorId: bytes(0x02), author: JIM }),
      edition({ rumorId: bytes(0x03), author: "c".repeat(64) }),
    ];
    expect(suspiciousActivity(editions, fold(), CID).map((a) => a.total)).toEqual([2, 1]);
  });
});


describe("invite-registry headroom", () => {
  const registryEditions = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      edition({ rumorId: bytes(0x30 + i), vsk: VSK_INVITE_REGISTRY, createdAt: 1_000 + i }),
    );

  it("stays silent below the threshold — buggy clients mint registries, flooders mint twenty", () => {
    expect(suspiciousActivity(registryEditions(INVITE_ALERT_THRESHOLD - 1), fold(), CID)).toEqual([]);
  });

  it("accuses alone at the threshold", () => {
    const [actor, ...rest] = suspiciousActivity(registryEditions(INVITE_ALERT_THRESHOLD), fold(), CID);
    expect(rest).toHaveLength(0);
    expect(actor.author).toBe(JIM);
    expect(actor.total).toBe(INVITE_ALERT_THRESHOLD);
    expect(actor.attempts.get(VSK_INVITE_REGISTRY)).toBe(INVITE_ALERT_THRESHOLD);
  });

  it("corroborates below the threshold once something real flagged the actor", () => {
    const editions = [edition({ rumorId: bytes(0x01), vsk: VSK_BANLIST }), ...registryEditions(2)];
    const [actor, ...rest] = suspiciousActivity(editions, fold(), CID);
    expect(rest).toHaveLength(0);
    expect(actor.total).toBe(3);
    expect(actor.attempts.get(VSK_BANLIST)).toBe(1);
    expect(actor.attempts.get(VSK_INVITE_REGISTRY)).toBe(2);
    expect(describeAttempts(actor.attempts)).toBe("2 invite link changes, 1 ban");
  });
});

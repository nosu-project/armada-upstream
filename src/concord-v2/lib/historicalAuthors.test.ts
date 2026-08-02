import { describe, expect, it } from "vitest";

import { historicalAuthorAllowlist } from "@/concord-v2/lib/historicalAuthors";
import { KIND_JOIN_LEAVE, KIND_KICK, KIND_SNAPSHOT } from "@/concord-v2/lib/kinds";
import { myLocator, ROOT_SCOPE_HEX, type ParsedRekey } from "@/concord-v2/lib/rekey";
import type { OpenedEvent } from "@/concord-v2/lib/stream";
import { Permissions, type CommunityRoles } from "@/concord-v2/lib/roles";

const OWNER = "aa".repeat(32);
const REFOUNDER = "bb".repeat(32);
const MEMBER = "cc".repeat(32);
const KEPT = "dd".repeat(32);
const KICKED = "ee".repeat(32);
const THROWAWAY = "0f".repeat(32);

function opened(kind: number, author: string, content = "", tags: string[][] = []): OpenedEvent {
  return { rumorId: "r" + author.slice(0, 8) + kind, author, kind, content, tags, ms: 1000, createdAt: 1 };
}

function snapshot(author: string, members: string[]): OpenedEvent {
  return opened(KIND_SNAPSHOT, author, JSON.stringify(members), [["snap", "s1", "1", "1"]]);
}

function round(rotator: string, newEpoch: bigint, recipients: string[]): ParsedRekey {
  return {
    rotator,
    scopeIdHex: ROOT_SCOPE_HEX,
    newEpoch,
    prevEpoch: newEpoch - 1n,
    prevCommit: "00".repeat(32),
    chunkIndex: 1,
    chunkCount: 1,
    blobs: recipients.map((pk) => ({ locator: myLocator(rotator, pk, ROOT_SCOPE_HEX, newEpoch), wrapped: "x" })),
    ms: 1000,
  };
}

describe("historicalAuthorAllowlist", () => {
  it("admits snapshot members from a recorded rotator, never from anyone else", () => {
    const { allowed, anchored } = historicalAuthorAllowlist({
      ownerHex: OWNER,
      refounders: [REFOUNDER],
      guestbook: [
        snapshot(REFOUNDER, [MEMBER]),
        // A "snapshot" sealed by a non-authority (an old keyholder CAN mint
        // this into a retired epoch) is ignored wholesale.
        snapshot(THROWAWAY, [THROWAWAY]),
      ],
    });
    expect(anchored).toBe(true);
    expect(allowed.has(MEMBER)).toBe(true);
    expect(allowed.has(THROWAWAY)).toBe(false);
    expect(allowed.has(OWNER)).toBe(true);
    expect(allowed.has(REFOUNDER)).toBe(true);
  });

  it("never trusts self-signed joins — they are the forgeable artifact", () => {
    const { allowed } = historicalAuthorAllowlist({
      ownerHex: OWNER,
      refounders: [REFOUNDER],
      guestbook: [snapshot(REFOUNDER, [MEMBER]), opened(KIND_JOIN_LEAVE, THROWAWAY, "join")],
    });
    expect(allowed.has(THROWAWAY)).toBe(false);
  });

  it("admits an AUTHORIZED kick's target (they were a member), ignores forged kicks", () => {
    const roster: CommunityRoles = {
      roles: [
        { roleId: "r1", name: "mod", position: 1, permissions: Permissions.KICK, scope: { kind: "server" as const }, color: 0 },
      ],
      grants: [{ member: MEMBER, roleIds: ["r1"] }],
    };
    const { allowed } = historicalAuthorAllowlist({
      ownerHex: OWNER,
      refounders: [REFOUNDER],
      roster,
      guestbook: [
        snapshot(REFOUNDER, []),
        opened(KIND_KICK, OWNER, "", [["p", KICKED]]),
        opened(KIND_KICK, THROWAWAY, "", [["p", THROWAWAY]]),
      ],
    });
    expect(allowed.has(KICKED)).toBe(true);
    expect(allowed.has(THROWAWAY)).toBe(false);
    // Roster grant holders were members regardless of the guestbook.
    expect(allowed.has(MEMBER)).toBe(true);
  });

  it("proves kept members by rekey-blob locator when the snapshot failed", () => {
    const { allowed, anchored } = historicalAuthorAllowlist({
      ownerHex: OWNER,
      refounders: [REFOUNDER],
      guestbook: [], // the best-effort snapshot never landed
      rekeyRounds: [round(REFOUNDER, 1n, [KEPT])],
      candidates: [KEPT, THROWAWAY],
    });
    expect(anchored).toBe(true);
    expect(allowed.has(KEPT)).toBe(true);
    expect(allowed.has(THROWAWAY)).toBe(false);
  });

  it("reports no anchor (caller fails open) when neither snapshot nor round exists", () => {
    const { anchored } = historicalAuthorAllowlist({
      ownerHex: OWNER,
      guestbook: [opened(KIND_JOIN_LEAVE, MEMBER, "join")],
    });
    expect(anchored).toBe(false);
  });
});

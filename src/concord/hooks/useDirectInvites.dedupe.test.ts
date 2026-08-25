import { describe, expect, it } from "vitest";

import { dedupeParkedInvites, type ParkedInvite } from "./useDirectInvites";
import type { InviteBundle } from "@/concord/lib/invite";

/** A minimal ParkedInvite for the dedup logic (only the read fields matter). */
function inv(
  over: Partial<ParkedInvite> & { communityId: string; wrapId: string; receivedAt: number },
): ParkedInvite {
  const channels = over.bundle?.channels ?? [];
  return {
    wrapId: over.wrapId,
    sender: over.sender ?? "sender",
    bundle: { community_id: over.communityId, name: "c", channels } as unknown as InviteBundle,
    communityId: over.communityId,
    name: over.name ?? "c",
    receivedAt: over.receivedAt,
    catchUp: over.catchUp,
  };
}

const chan = (id: string) => ({ id, key: "1".repeat(64), epoch: 0, name: "ch" });

describe("dedupeParkedInvites", () => {
  it("collapses a re-invite to one row per community, keeping the newest wrap", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "old", receivedAt: 100 }),
      inv({ communityId: "A", wrapId: "new", receivedAt: 200 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].wrapId).toBe("new");
  });

  it("keeps invites to different communities apart", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "a", receivedAt: 100 }),
      inv({ communityId: "B", wrapId: "b", receivedAt: 100 }),
    ]);
    expect(new Set(out.map((i) => i.communityId))).toEqual(new Set(["A", "B"]));
  });

  it("breaks a receivedAt tie deterministically by wrap id (lower wins)", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "zzz", receivedAt: 100 }),
      inv({ communityId: "A", wrapId: "aaa", receivedAt: 100 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].wrapId).toBe("aaa");
  });

  it("collapses catch-ups that carry the SAME channel set", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "old", receivedAt: 100, catchUp: true, bundle: { channels: [chan("cc")] } as unknown as InviteBundle }),
      inv({ communityId: "A", wrapId: "new", receivedAt: 200, catchUp: true, bundle: { channels: [chan("cc")] } as unknown as InviteBundle }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].wrapId).toBe("new");
  });

  it("keeps catch-ups for the same community that vend DIFFERENT channels", () => {
    // Each carries a private-channel key the member still lacks; collapsing by
    // community would hide a key that exists in no other wrap.
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "aa", receivedAt: 100, catchUp: true, bundle: { channels: [chan("aa")] } as unknown as InviteBundle }),
      inv({ communityId: "A", wrapId: "bb", receivedAt: 100, catchUp: true, bundle: { channels: [chan("bb")] } as unknown as InviteBundle }),
    ]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((i) => i.wrapId))).toEqual(new Set(["aa", "bb"]));
  });

  it("normalizes channel-id case so one channel spelled two ways is one key", () => {
    const out = dedupeParkedInvites([
      inv({ communityId: "A", wrapId: "lo", receivedAt: 100, catchUp: true, bundle: { channels: [chan("abcd")] } as unknown as InviteBundle }),
      inv({ communityId: "A", wrapId: "up", receivedAt: 200, catchUp: true, bundle: { channels: [chan("ABCD")] } as unknown as InviteBundle }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].wrapId).toBe("up");
  });
});

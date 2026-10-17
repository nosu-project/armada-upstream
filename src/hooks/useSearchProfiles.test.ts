import { describe, expect, it } from "vitest";

import { profileMatchRank, type SearchProfile } from "./useSearchProfiles";

import type { NostrMetadata } from "@nostrify/nostrify";

function profile(pubkey: string, metadata: NostrMetadata): SearchProfile {
  return { pubkey, metadata, event: { pubkey, tags: [], content: "", kind: 0, created_at: 0, id: "" } };
}

describe("profileMatchRank", () => {
  const orionis = profile("a", { name: "Orionis", nip05: "orionis@orionis.social" });
  const bellatrix = profile("b", { name: "Bellatrix✨", nip05: "bellatrix@orionis.social" });

  it("ranks a name prefix above a NIP-05 domain hit", () => {
    expect(profileMatchRank(orionis, "or")).toBeLessThan(profileMatchRank(bellatrix, "or"));
  });

  it("orders name prefix, word prefix, nip05 local part, name substring, domain", () => {
    const ranks = [
      profile("1", { name: "Orion" }),
      profile("2", { display_name: "Big Orca" }),
      profile("3", { name: "X", nip05: "orc@example.com" }),
      profile("4", { name: "Thorn" }),
      profile("5", { name: "Y", nip05: "y@orbit.net" }),
    ].map((p) => profileMatchRank(p, "or"));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("sums across query words", () => {
    const p = profile("c", { display_name: "Ana Bell" });
    expect(profileMatchRank(p, "ana bell")).toBeLessThan(profileMatchRank(p, "ana ell"));
  });
});

/**
 * CORD-02 §8 (Community List) conformance ledger — same charter as
 * `cord04.conformance.test.ts`. CORD-01's encoding rules apply to everything
 * in the list ("hex is lowercase"), but a merge is fed by OTHER clients'
 * documents, so this file treats foreign spellings as hostile input: an
 * uppercase channel id must never dodge a cut floor or fork a union entry.
 */

import { describe, expect, it } from "vitest";

import {
  applyChannelCuts,
  mergeChannelCuts,
  unionChannelKeys,
} from "./communityList";

const chan = (id: string, epoch: number, key = "1".repeat(64)) => ({ id, key, epoch, name: "c" });

describe("CORD-02 §8 — Community List", () => {
  it.todo("O-1: the list is one kind 13302 replaceable, NIP-44-encrypted to self (communityList tests)");
  it.todo("O-2: seed only ever moves BACKWARD on merge; current only forward (communityList.test.ts)");
  it.todo("O-3: an epoch tie breaks on the lexicographically lowest canonical bytes (communityList.test.ts)");
  it.todo("O-4: tombstones are permanent and per-community; newest of added_at/removed_at wins");
  it.todo("O-5: the list caps at 50 memberships and MUST fit its NIP-44 envelope before publishing");
  it.todo("O-6: unknown fields round-trip untouched (communityList.test.ts rehydration case)");

  it("O-7: a channel id compares case-insensitively in the key union (CORD-01: hex is lowercase; foreign input may not be)", () => {
    // The same channel spelled two ways must fold to ONE entry, not two —
    // else a foreign client's uppercase list forks the union and both "copies"
    // drift independently forever.
    const merged = unionChannelKeys([chan("aa".repeat(32), 0)], [chan("AA".repeat(32), 1, "2".repeat(64))]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("aa".repeat(32)); // one canonical (lowercase) spelling out
    expect(merged[0].epoch).toBe(1);
  });

  it("O-8: a cut floor holds against a differently-cased spelling of the same channel", () => {
    // The security-relevant path: channel_cuts is what stops a stale bundle
    // restoring revoked access (CORD-06 §2 removal, made monotonic). A floor
    // that string-compares ids lets an uppercase respelling of the revoked
    // key walk straight past it.
    const cuts = mergeChannelCuts([{ id: "aa".repeat(32), epoch: 2 }], undefined);
    expect(applyChannelCuts([chan("AA".repeat(32), 0)], cuts)).toEqual([]);
    // And the cut map itself unions case-insensitively: max epoch wins.
    const merged = mergeChannelCuts([{ id: "aa".repeat(32), epoch: 2 }], [{ id: "AA".repeat(32), epoch: 5 }]);
    expect(merged).toEqual([{ id: "aa".repeat(32), epoch: 5 }]);
  });

  it("O-9: a re-admission at/above the cut epoch is honored whatever its spelling", () => {
    const cuts = mergeChannelCuts([{ id: "aa".repeat(32), epoch: 2 }], undefined);
    expect(applyChannelCuts([chan("AA".repeat(32), 2, "2".repeat(64))], cuts)).toHaveLength(1);
  });
});

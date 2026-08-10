/**
 * The Git ticket child filters shed their bootstrap `limit` once a relay's
 * round has EOSEd.
 *
 * Those filters carry `limit: 4_000` so the round that installs a newly
 * discovered root can pull that ticket's whole comment/status history. The
 * bound then applied to every later rotation too, and the wire re-REQs each
 * relay on a 90s quiet rotation — so a relay whose cursor sits behind the
 * tickets it serves re-delivered up to 4,000 stored children per rotation, per
 * relay. A live idle client measured 93% of NIP-34 deliveries as copies of an
 * event already in hand, across four relays carrying the same repositories.
 *
 * The rule mirrors the NIP-17 wrap filter's existing steady-state cap.
 */
import { describe, expect, it } from "vitest";
import type { NostrFilter } from "@nostrify/nostrify";

import { stampRoundSince } from "@/wire/spec";

const NOW = 1_800_000_000;
const SINCE = NOW - 60;

/** `{kinds:[1111], "#E":[root]}` — the NIP-22 comment child filter. */
const comments: NostrFilter = { kinds: [1111], "#E": ["a".repeat(64)], since: 1_700_000_000, limit: 4_000 };
/** `{kinds:[1630..1633], "#e":[root]}` — the NIP-34 status child filter. */
const statuses: NostrFilter = {
  kinds: [1630, 1631, 1632, 1633],
  "#e": ["a".repeat(64)],
  since: 1_700_000_000,
  limit: 4_000,
};

describe("stampRoundSince — Git child replay cap", () => {
  it("keeps the full bound on the round that installs the filter", () => {
    // The installing round is the one carrying the root-derived `since`
    // (preserveExplicitSince), and it is the round meant to pull history.
    const [out] = stampRoundSince([comments], SINCE, NOW, true, true);
    expect(out.limit).toBe(4_000);
    expect(out.since).toBe(1_700_000_000);
  });

  it("keeps the full bound before EOSE", () => {
    const [out] = stampRoundSince([comments], SINCE, NOW, false, false);
    expect(out.limit).toBe(4_000);
  });

  it("caps the comment filter on a steady-state rotation", () => {
    const [out] = stampRoundSince([comments], SINCE, NOW, false, true);
    expect(out.limit).toBe(100);
    expect(out.since).toBe(SINCE);
  });

  it("caps the status filter on a steady-state rotation", () => {
    const [out] = stampRoundSince([statuses], SINCE, NOW, false, true);
    expect(out.limit).toBe(100);
  });

  it("never raises a limit that is already smaller", () => {
    const small: NostrFilter = { ...comments, limit: 10 };
    const [out] = stampRoundSince([small], SINCE, NOW, false, true);
    expect(out.limit).toBe(10);
  });

  it("leaves unrelated filters carrying #e alone", () => {
    // A reaction or thread filter also uses `#e`; only the exact Git kind sets
    // may be re-capped, or an unrelated subscription would silently truncate.
    const reactions: NostrFilter = { kinds: [7], "#e": ["a".repeat(64)], limit: 4_000 };
    const [out] = stampRoundSince([reactions], SINCE, NOW, false, true);
    expect(out.limit).toBe(4_000);
  });

  it("leaves a partial Git status kind set alone", () => {
    const partial: NostrFilter = { kinds: [1630], "#e": ["a".repeat(64)], limit: 4_000 };
    const [out] = stampRoundSince([partial], SINCE, NOW, false, true);
    expect(out.limit).toBe(4_000);
  });

  it("does not disturb the DM wrap filter's own cap", () => {
    const wrap: NostrFilter = { kinds: [1059], "#p": ["b".repeat(64)] };
    const [out] = stampRoundSince([wrap], SINCE, NOW, false, true);
    expect(out.limit).toBe(10);
  });
});

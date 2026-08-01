/**
 * The pool routing rule's edges — each one is a way the narrowing could lose
 * data if it were wrong, so each is pinned:
 *
 *  - generic kinds stay off the servers (the whole point);
 *  - an empty general set falls back to the full pool (air-gapped deployments
 *    run on servers alone);
 *  - a kind-less filter keeps the full pool (an ids-only lookup can live
 *    anywhere);
 *  - the kind-10009 server list keeps the full pool (a server may hold the
 *    only copy).
 */
import { describe, expect, it } from "vitest";

import { poolReqTargets } from "./poolRouting";

const GENERAL = ["wss://app.example", "wss://nip65.example"];
const ALL = [...GENERAL, "wss://server.example", "wss://git.example"];

describe("poolReqTargets", () => {
  it("routes generic kinds to the general relays only", () => {
    expect(poolReqTargets([{ kinds: [0], authors: ["a"] }], GENERAL, ALL)).toEqual(GENERAL);
    expect(
      poolReqTargets(
        [{ kinds: [0], authors: ["a"] }, { kinds: [30315], authors: ["a"], "#d": ["general"] }],
        GENERAL,
        ALL,
      ),
    ).toEqual(GENERAL);
  });

  it("falls back to the full pool when the general set is empty", () => {
    expect(poolReqTargets([{ kinds: [0] }], [], ALL)).toEqual(ALL);
  });

  it("keeps the full pool for a kind-less filter", () => {
    expect(poolReqTargets([{ ids: ["e".repeat(64)] }], GENERAL, ALL)).toEqual(ALL);
  });

  it("keeps the full pool when any filter asks for the kind-10009 server list", () => {
    expect(
      poolReqTargets([{ kinds: [0] }, { kinds: [10009], authors: ["a"] }], GENERAL, ALL),
    ).toEqual(ALL);
  });
});

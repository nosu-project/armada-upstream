/** Relay trust from read-backs: an OK alone stops counting after repeated false ones. */
import { afterEach, describe, expect, it } from "vitest";

import { purgeArmadaDB } from "@/lib/db/armadaDB";
import { resetKvCaches } from "@/lib/db/kvCache";

import { _scoreForTests, isRelayTrusted, outgoingVerifyReady } from "./outgoingVerify";

afterEach(async () => {
  await purgeArmadaDB();
  resetKvCaches();
});

describe("isRelayTrusted", () => {
  it("trusts an unknown relay, and one whose OKs mostly hold", async () => {
    await outgoingVerifyReady();
    expect(isRelayTrusted("wss://new")).toBe(true);
    _scoreForTests("wss://good", false);
    for (let i = 0; i < 4; i++) _scoreForTests("wss://good", true);
    for (let i = 0; i < 2; i++) _scoreForTests("wss://good", false);
    expect(isRelayTrusted("wss://good")).toBe(true);
  });

  it("distrusts a relay after three false OKs that outnumber its true ones", async () => {
    await outgoingVerifyReady();
    _scoreForTests("wss://liar", false);
    _scoreForTests("wss://liar", true);
    _scoreForTests("wss://liar", false);
    expect(isRelayTrusted("wss://liar")).toBe(true);
    _scoreForTests("wss://liar", false);
    expect(isRelayTrusted("wss://liar")).toBe(false);
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import {
  completePushIdMigration,
  loadPushRegistrationState,
  loadRegisteredPushIds,
  savePushRegistrationState,
  saveRegisteredPushIds,
  type PushRegistryScope,
} from "@/lib/pushRegistry";
import { scopePushSubscriptionId } from "@/lib/pushSubscriptions";

const A = "a".repeat(64);
const B = "b".repeat(64);
const DOMAIN = "armada.buzz";

function scope(pubkey: string, installation: string): PushRegistryScope {
  return { pubkey, domain: DOMAIN, installation };
}

beforeEach(() => localStorage.clear());

describe("scoped push registry", () => {
  it("keeps accounts and installs in independent prune sets", () => {
    savePushRegistrationState(scope(A, "browser-a"), {
      ids: ["a-id"],
      legacyMigrationComplete: true,
    });
    savePushRegistrationState(scope(B, "browser-b"), {
      ids: ["b-id"],
      legacyMigrationComplete: true,
    });

    expect(loadPushRegistrationState(scope(A, "browser-a")).ids).toEqual(["a-id"]);
    expect(loadPushRegistrationState(scope(B, "browser-b")).ids).toEqual(["b-id"]);
    expect(loadPushRegistrationState(scope(A, "browser-other")).ids).toEqual([]);
  });

  it("adopts only the outgoing account's flat legacy ids", () => {
    const aLegacy = scopePushSubscriptionId("armada-dm17", A, DOMAIN);
    const bLegacy = scopePushSubscriptionId("armada-dm17", B, DOMAIN);
    saveRegisteredPushIds([bLegacy, aLegacy]);

    expect(loadPushRegistrationState(scope(A, "browser-a")).ids).toEqual([aLegacy]);
    expect(loadPushRegistrationState(scope(B, "browser-b")).ids).toEqual([bLegacy]);
  });

  it("synthesizes current legacy ids until new ids have safely replaced them", () => {
    const legacy = scopePushSubscriptionId("armada-groups", A, DOMAIN);
    const current = scopePushSubscriptionId("armada-groups", A, DOMAIN, "browser-a");

    expect(loadPushRegistrationState(scope(A, "browser-a"), [legacy])).toEqual({
      ids: [legacy],
      legacyMigrationComplete: false,
    });

    completePushIdMigration(scope(A, "browser-a"), [current]);
    expect(loadPushRegistrationState(scope(A, "browser-a"), [legacy])).toEqual({
      ids: [current],
      legacyMigrationComplete: true,
    });
  });

  it("removes only the migrated account from the flat registry", () => {
    const aLegacy = scopePushSubscriptionId("armada-dm17", A, DOMAIN);
    const bLegacy = scopePushSubscriptionId("armada-dm17", B, DOMAIN);
    saveRegisteredPushIds([aLegacy, bLegacy]);

    completePushIdMigration(scope(A, "browser-a"), []);

    expect(loadRegisteredPushIds()).toEqual([bLegacy]);
  });
});

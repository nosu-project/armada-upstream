import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mutateWebPushRegistrations } from "@/hooks/useNostrPush";
import {
  _resetBeforeAccountExitForTests,
  registerBeforeAccountExit,
  runBeforeAccountExit,
} from "@/lib/beforeAccountExit";
import { purgeClientStorage } from "@/lib/purgeClientStorage";
import {
  loadPushRegistrationState,
  PUSH_CLEANUP_KEY,
  PUSH_INSTALLATION_KEY,
  pushInstallationId,
  savePushRegistrationState,
} from "@/lib/pushRegistry";
import { scopePushSubscriptionId } from "@/lib/pushSubscriptions";

const A = "a".repeat(64);
const B = "b".repeat(64);
const DOMAIN = "armada.buzz";

beforeEach(() => {
  localStorage.clear();
  _resetBeforeAccountExitForTests();
  vi.useRealTimers();
});

afterEach(() => {
  _resetBeforeAccountExitForTests();
  vi.useRealTimers();
});

describe("final-logout push cleanup recovery", () => {
  it("preserves timed-out ids for only the same signer and deletes them after relogin", async () => {
    const installation = pushInstallationId();
    const aScope = { pubkey: A, domain: DOMAIN, installation };
    const bScope = { pubkey: B, domain: DOMAIN, installation };
    const aId = scopePushSubscriptionId("armada-dm17", A, DOMAIN, installation);
    const bId = scopePushSubscriptionId("armada-dm17", B, DOMAIN, installation);
    savePushRegistrationState(aScope, {
      ids: [aId],
      legacyMigrationComplete: true,
    });
    savePushRegistrationState(bScope, {
      ids: [bId],
      legacyMigrationComplete: true,
    });

    // The gateway teardown never answers, so final logout reaches its bound
    // and proceeds to the broad local-storage purge with both ordinary scoped
    // records still present.
    registerBeforeAccountExit(() => new Promise<void>(() => {}));
    vi.useFakeTimers();
    const exit = runBeforeAccountExit("final-logout", 10);
    await vi.advanceTimersByTimeAsync(10);
    await exit;
    vi.useRealTimers();

    await purgeClientStorage(A);

    // The stable install dimension and hash-only tombstone survive. Neither
    // account pubkey is retained in the tombstone itself.
    expect(pushInstallationId()).toBe(installation);
    const tombstone = localStorage.getItem(PUSH_CLEANUP_KEY);
    expect(tombstone).not.toBeNull();
    expect(tombstone).not.toContain(A);
    expect(tombstone).not.toContain(B);

    // A different signer sharing this browser cannot enumerate A's orphan (or
    // its own pre-purge registry entry); only the exact hash match can merge.
    expect(loadPushRegistrationState(bScope).ids).toEqual([]);
    expect(loadPushRegistrationState(aScope).ids).toEqual([aId]);

    const otherDelete = vi.fn(async () => {});
    await mutateWebPushRegistrations({
      kind: "delete",
      client: { deleteSubscription: otherDelete },
      pubkey: B,
      domain: DOMAIN,
      installation,
      legacyIds: [],
    } as unknown as Parameters<typeof mutateWebPushRegistrations>[0], () => true);
    expect(otherDelete).not.toHaveBeenCalled();
    expect(localStorage.getItem(PUSH_CLEANUP_KEY)).not.toBeNull();

    const deleteSubscription = vi.fn(async () => {});
    await mutateWebPushRegistrations({
      kind: "delete",
      client: { deleteSubscription },
      pubkey: A,
      domain: DOMAIN,
      installation,
      legacyIds: [],
    } as unknown as Parameters<typeof mutateWebPushRegistrations>[0], () => true);

    expect(deleteSubscription).toHaveBeenCalledTimes(1);
    expect(deleteSubscription).toHaveBeenCalledWith(aId, DOMAIN);
    expect(deleteSubscription).not.toHaveBeenCalledWith(bId, DOMAIN);
    // The matching tombstone is consumed only after the now-empty scoped state
    // has been durably saved by reconciliation.
    expect(localStorage.getItem(PUSH_CLEANUP_KEY)).toBeNull();
    expect(loadPushRegistrationState(aScope).ids).toEqual([]);
  });

  it("redirects a timed-out handler's late save away from the purged raw registry", async () => {
    const installation = pushInstallationId();
    const scope = { pubkey: A, domain: DOMAIN, installation };
    const id = scopePushSubscriptionId("armada-c2-old", A, DOMAIN, installation);
    savePushRegistrationState(scope, {
      ids: [id],
      legacyMigrationComplete: true,
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let lateSave!: Promise<void>;
    registerBeforeAccountExit(() => {
      lateSave = (async () => {
        await gate;
        // Mirrors a queued reconciliation resuming after the bounded exit
        // runner has already let final logout continue.
        savePushRegistrationState(scope, {
          ids: [id],
          legacyMigrationComplete: true,
        });
      })();
      return lateSave;
    });

    vi.useFakeTimers();
    const exit = runBeforeAccountExit("final-logout", 10);
    await vi.advanceTimersByTimeAsync(10);
    await exit;
    vi.useRealTimers();
    await purgeClientStorage(A);

    expect(localStorage.getItem("armada:nostr-push-subs:v2")).toBeNull();
    release();
    await lateSave;

    // Late work may update the opaque recovery record, but can never recreate
    // the raw `[domain,pubkey,installation]` registry the purge removed.
    expect(localStorage.getItem("armada:nostr-push-subs:v2")).toBeNull();
    const tombstone = localStorage.getItem(PUSH_CLEANUP_KEY);
    expect(tombstone).not.toBeNull();
    expect(tombstone).not.toContain(A);
    expect(loadPushRegistrationState(scope).ids).toEqual([id]);
  });

  it("restores the install id when a first registration succeeds after purge", async () => {
    const installation = pushInstallationId();
    const scope = { pubkey: A, domain: DOMAIN, installation };
    const id = scopePushSubscriptionId("armada-dm17", A, DOMAIN, installation);

    // Reconciliation persists its initially empty prune set before starting
    // the first network PUT. There is therefore no orphan id for purge to
    // stage if account exit times out while that PUT is still in flight.
    savePushRegistrationState(scope, {
      ids: [],
      legacyMigrationComplete: true,
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let lateSave!: Promise<void>;
    registerBeforeAccountExit(() => {
      lateSave = (async () => {
        await gate;
        // The gateway committed the PUT after the final purge already ran.
        savePushRegistrationState(scope, {
          ids: [id],
          legacyMigrationComplete: true,
        });
      })();
      return lateSave;
    });

    vi.useFakeTimers();
    const exit = runBeforeAccountExit("final-logout", 10);
    await vi.advanceTimersByTimeAsync(10);
    await exit;
    vi.useRealTimers();
    await purgeClientStorage(A);

    // Fencing preserves the old opaque install identity before any late work
    // can race a newly generated one into this origin.
    expect(localStorage.getItem(PUSH_INSTALLATION_KEY)).toBe(installation);
    release();
    await lateSave;

    // A same-signer reload can merge and delete that exact late orphan.
    expect(localStorage.getItem(PUSH_INSTALLATION_KEY)).toBe(installation);
    expect(pushInstallationId()).toBe(installation);
    expect(localStorage.getItem(PUSH_CLEANUP_KEY)).not.toContain(A);
    expect(loadPushRegistrationState(scope).ids).toEqual([id]);
  });
});

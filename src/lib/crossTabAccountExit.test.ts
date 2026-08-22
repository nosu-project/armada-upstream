import { describe, expect, it, vi } from "vitest";

import { ACTIVE_PUBKEY_KEY } from "@/lib/activeAccount";
import {
  ACCOUNT_EXIT_EPOCH_KEY,
  beginCrossTabAccountExit,
  installCrossTabAccountExit,
} from "@/lib/crossTabAccountExit";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("cross-tab account exit", () => {
  it("fences followers on pre-exit and reloads them only after the active marker settles", () => {
    const order: string[] = [];
    const reloadA = vi.fn(() => { order.push("reload-a"); });
    const reloadB = vi.fn(() => { order.push("reload-b"); });
    const removeA = installCrossTabAccountExit({
      pubkey: A,
      fence: () => { order.push("fence-a"); },
      reload: reloadA,
    });
    const removeB = installCrossTabAccountExit({
      pubkey: A,
      fence: () => { order.push("fence-b"); },
      reload: reloadB,
    });

    window.dispatchEvent(new StorageEvent("storage", {
      key: ACCOUNT_EXIT_EPOCH_KEY,
      newValue: JSON.stringify({ id: "epoch", fromPubkey: A, toPubkey: B }),
    }));
    expect(order).toEqual(["fence-a", "fence-b"]);
    expect(reloadA).not.toHaveBeenCalled();
    expect(reloadB).not.toHaveBeenCalled();

    window.dispatchEvent(new StorageEvent("storage", {
      key: ACTIVE_PUBKEY_KEY,
      oldValue: A,
      newValue: B,
    }));
    expect(order).toEqual([
      "fence-a",
      "fence-b",
      "reload-a",
      "reload-b",
    ]);
    removeA();
    removeB();
  });

  it("ignores unrelated storage and the same active pubkey", () => {
    const fence = vi.fn();
    const remove = installCrossTabAccountExit({
      pubkey: A,
      fence,
      reload: vi.fn(),
    });

    window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: B }));
    window.dispatchEvent(new StorageEvent("storage", {
      key: ACTIVE_PUBKEY_KEY,
      newValue: A,
    }));
    expect(fence).not.toHaveBeenCalled();
    remove();
  });

  it("fences the cleanup leader locally before it can mutate shared push state", () => {
    const fence = vi.fn();
    const reload = vi.fn();
    const remove = installCrossTabAccountExit({ pubkey: A, fence, reload });

    const epoch = beginCrossTabAccountExit(A, B);
    expect(epoch).toMatchObject({ fromPubkey: A, toPubkey: B });
    expect(fence).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    remove();
  });

  it("never lets a follower run destructive shared cleanup after the next account activates", () => {
    const destructiveCleanup = vi.fn();
    const remove = installCrossTabAccountExit({
      pubkey: A,
      fence: vi.fn(),
      reload: vi.fn(),
    });
    window.dispatchEvent(new StorageEvent("storage", {
      key: ACCOUNT_EXIT_EPOCH_KEY,
      newValue: JSON.stringify({ id: "epoch", fromPubkey: A, toPubkey: B }),
    }));
    window.dispatchEvent(new StorageEvent("storage", {
      key: ACTIVE_PUBKEY_KEY,
      newValue: B,
    }));

    // There is intentionally no follower `exit` callback in the API. Only the
    // initiating switch path runs beforeAccountExit; a slow tab cannot later
    // unsubscribe/clear B's origin-global endpoint.
    expect(destructiveCleanup).not.toHaveBeenCalled();
    remove();
  });
});

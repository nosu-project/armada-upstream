import { describe, expect, it, vi } from "vitest";

import { clearGroupListMemo, readGroupListEvent } from "./useUserGroupList";

import type { NostrRumor } from "@/lib/nostrRumor";

const SELF = "a".repeat(64);

function listEvent(n: number): NostrRumor {
  return {
    id: `list${n}`.padEnd(64, "0"),
    pubkey: SELF,
    created_at: 1000 + n,
    kind: 10009,
    tags: [],
    content: `enc:${JSON.stringify([["r", "wss://secret.example/"]])}`,
  } as NostrRumor;
}

function signer() {
  const decrypt = vi.fn(async (_pk: string, ct: string) => ct.slice(4));
  return { decrypt, signer: { nip44: { decrypt, encrypt: vi.fn() } } as never };
}

describe("groupListDecryptMemo", () => {
  it("keeps only the newest version per author", async () => {
    clearGroupListMemo();
    const { decrypt, signer: s } = signer();
    for (let i = 0; i < 3; i++) await readGroupListEvent(listEvent(i), s);
    expect(decrypt).toHaveBeenCalledTimes(3);
    await readGroupListEvent(listEvent(2), s);
    expect(decrypt).toHaveBeenCalledTimes(3);
    // A superseded version was evicted, and reading it doesn't displace the newest.
    await readGroupListEvent(listEvent(0), s);
    await readGroupListEvent(listEvent(2), s);
    expect(decrypt).toHaveBeenCalledTimes(4);
  });

  it("serves nothing from memory after clearGroupListMemo", async () => {
    const { signer: s } = signer();
    await readGroupListEvent(listEvent(5), s);
    clearGroupListMemo();
    const other = { nip44: { decrypt: vi.fn(async () => { throw new Error("wrong key"); }), encrypt: vi.fn() } } as never;
    const r = await readGroupListEvent(listEvent(5), other);
    expect(r.decryptFailed).toBe(true);
  });
});

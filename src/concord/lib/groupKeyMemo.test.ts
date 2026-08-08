import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetGroupKeyMemoForTests,
  bytesToHex,
  channelGroupKey,
  controlGroupKey,
  exportGroupKeyMemo,
  importGroupKeyMemo,
  onGroupKeyMemoDirty,
} from "@/concord/lib/derive";

const A = new Uint8Array(32).fill(1);
const B = new Uint8Array(32).fill(2);

describe("groupKey memo persistence seams", () => {
  beforeEach(() => {
    _resetGroupKeyMemoForTests();
  });

  it("round-trips a derivation through export/import without changing it", () => {
    const original = channelGroupKey(A, B, 0);
    const skHex = bytesToHex(original.sk);
    const convHex = bytesToHex(original.convKey); // forces the lazy ECDH

    const exported = exportGroupKeyMemo(4096);
    _resetGroupKeyMemoForTests();
    importGroupKeyMemo(exported);

    const revived = channelGroupKey(A, B, 0);
    expect(revived.pk).toBe(original.pk);
    expect(bytesToHex(revived.sk)).toBe(skHex);
    expect(bytesToHex(revived.convKey)).toBe(convHex);
  });

  it("persists ck only once the lazy convKey has been read", () => {
    channelGroupKey(A, B, 0);
    expect(exportGroupKeyMemo(4096)[0].ck).toBeUndefined();

    void channelGroupKey(A, B, 0).convKey;
    expect(exportGroupKeyMemo(4096)[0].ck).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps unclaimed hydrated entries across an export", () => {
    // Session 1 derives two keys; session 2 only touches one of them.
    channelGroupKey(A, B, 0);
    controlGroupKey(A, B, 0);
    const exported = exportGroupKeyMemo(4096);
    expect(exported).toHaveLength(2);

    _resetGroupKeyMemoForTests();
    importGroupKeyMemo(exported);
    channelGroupKey(A, B, 0);

    // The untouched control key survives the next save.
    expect(exportGroupKeyMemo(4096)).toHaveLength(2);
  });

  it("skips malformed imported entries and derives correctly anyway", () => {
    const truth = channelGroupKey(A, B, 0);
    _resetGroupKeyMemoForTests();

    importGroupKeyMemo([
      null,
      42,
      { h: "nothex", sk: "nope", pk: "nope" },
      { h: "aa".repeat(32) }, // missing key material
      { h: "aa".repeat(32), sk: "bb".repeat(32), pk: "cc".repeat(32), ck: "bad" },
    ]);

    expect(channelGroupKey(A, B, 0).pk).toBe(truth.pk);
  });

  it("signals dirty on a fresh derivation and on the lazy ECDH, not on a memo hit", () => {
    let fired = 0;
    onGroupKeyMemoDirty(() => fired++);

    const key = channelGroupKey(A, B, 0);
    expect(fired).toBe(1);

    channelGroupKey(A, B, 0); // memo hit
    expect(fired).toBe(1);

    void key.convKey; // lazy ECDH fills ck
    expect(fired).toBe(2);
    void key.convKey; // already filled
    expect(fired).toBe(2);
  });

  it("caps an export at the requested limit, dropping oldest first", () => {
    for (let epoch = 0; epoch < 10; epoch++) channelGroupKey(A, B, epoch);
    const exported = exportGroupKeyMemo(4);
    expect(exported).toHaveLength(4);
    expect(exported[3].h).toBe(exportGroupKeyMemo(4096)[9].h);
  });
});

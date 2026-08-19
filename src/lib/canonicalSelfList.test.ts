import { describe, expect, it } from "vitest";

import {
  newestCanonicalSelfList,
  replaceableIsNewerThanMetadata,
} from "@/lib/canonicalSelfList";

import type { NostrRumor } from "@/lib/nostrRumor";

const PUBKEY = "a".repeat(64);

function rumor(kind: number, id: string, createdAt: number): NostrRumor {
  return {
    id,
    pubkey: PUBKEY,
    kind,
    created_at: createdAt,
    tags: [],
    content: "",
  };
}

describe("canonical self-list winner", () => {
  it("keeps a newer unsigned ArmadaDB rumor over a stale signed wire copy", () => {
    const staleWire = { ...rumor(10050, "1".repeat(64), 10), sig: "f".repeat(128) };
    const newerLocal = rumor(10050, "2".repeat(64), 20);

    expect(newestCanonicalSelfList(
      [staleWire, newerLocal],
      PUBKEY,
      10050,
    )).toBe(newerLocal);
  });

  it("uses the lower id for an equal-second collision", () => {
    const higherId = rumor(10063, "f".repeat(64), 20);
    const lowerId = rumor(10063, "0".repeat(64), 20);

    expect(newestCanonicalSelfList(
      [higherId, lowerId],
      PUBKEY,
      10063,
    )).toBe(lowerId);
  });

  it("lets a legacy metadata mirror adopt an equal-second winner once", () => {
    const candidate = rumor(10063, "0".repeat(64), 20);

    expect(replaceableIsNewerThanMetadata(candidate, { updatedAt: 20 })).toBe(true);
    expect(replaceableIsNewerThanMetadata(candidate, {
      updatedAt: 20,
      eventId: "f".repeat(64),
    })).toBe(true);
    expect(replaceableIsNewerThanMetadata(candidate, {
      updatedAt: 20,
      eventId: candidate.id,
    })).toBe(false);
  });
});

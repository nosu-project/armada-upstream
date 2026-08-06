import { describe, expect, it, vi } from "vitest";

import { readSearchRelayList } from "@/lib/searchRelayList";

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";

function event(tags: string[][], content = ""): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: "2".repeat(64),
    sig: "3".repeat(128),
    kind: 10007,
    created_at: 1,
    tags,
    content,
  };
}

describe("search relay lists", () => {
  it("normalizes and deduplicates public relay tags", async () => {
    const result = await readSearchRelayList(
      event([
        ["relay", "WSS://SEARCH.EXAMPLE/"],
        ["relay", "wss://search.example"],
        ["other", "preserved"],
      ]),
      {} as NostrSigner,
    );

    expect(result).toMatchObject({
      relays: ["wss://search.example"],
      publicRelays: ["wss://search.example"],
      privateRelays: [],
      decryptFailed: false,
    });
  });

  it("combines public and NIP-44 private items", async () => {
    const decrypt = vi.fn().mockResolvedValue(JSON.stringify([
      ["relay", "private.example"],
      ["other", "kept"],
    ]));
    const result = await readSearchRelayList(
      event([["relay", "wss://public.example"]], "ciphertext"),
      { nip44: { decrypt } } as unknown as NostrSigner,
    );

    expect(decrypt).toHaveBeenCalledWith("2".repeat(64), "ciphertext");
    expect(result).toMatchObject({
      relays: ["wss://public.example", "wss://private.example"],
      publicRelays: ["wss://public.example"],
      privateRelays: ["wss://private.example"],
      decryptFailed: false,
    });
  });

  it("does not mistake an unreadable private list for an intentional empty list", async () => {
    const result = await readSearchRelayList(
      event([], "ciphertext"),
      {} as NostrSigner,
    );
    expect(result).toMatchObject({ relays: [], decryptFailed: true });
  });
});

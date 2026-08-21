import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { KIND_RELAY_LIST } from "@/lib/nip65";
import {
  admitSelfSyncEvent,
  KIND_APP_SPECIFIC,
  KIND_BLOSSOM_SERVERS,
  KIND_DM_RELAYS,
  KIND_SEARCH_RELAYS,
  queryKeysForSelfEvent,
  selfSyncTopicOf,
  SELF_SYNC_OWNER_QUERY_KEYS,
  SELF_SYNC_REPLACEABLE_KINDS,
  SELF_SYNC_TOPIC_TAGS,
  T_ARMADA_DM_CONVERSATIONS,
  T_ARMADA_GIF_FAVORITES,
} from "@/lib/selfSyncKinds";

describe("queryKeysForSelfEvent", () => {
  it("keeps the NIP-65 pointer in the standing bare-kind subscription", () => {
    expect(SELF_SYNC_REPLACEABLE_KINDS).toContain(KIND_RELAY_LIST);
  });

  it("routes encrypted GIF favorite shards to their sync query", () => {
    expect(
      queryKeysForSelfEvent(
        KIND_APP_SPECIFIC,
        "armada/gif-favorites/device-id",
        T_ARMADA_GIF_FAVORITES,
      ),
    ).toEqual([["favorite-gifs-sync"]]);
  });

  it("routes encrypted DM-conversation shards to their sync query", () => {
    expect(
      queryKeysForSelfEvent(
        KIND_APP_SPECIFIC,
        "armada/dm-conversations/device-id",
        T_ARMADA_DM_CONVERSATIONS,
      ),
    ).toEqual([["dm-conversations-sync"]]);
  });

  it("finds a recognized topic after an unrelated leading topic", () => {
    expect(selfSyncTopicOf([
      ["t", "other-app"],
      ["t", T_ARMADA_DM_CONVERSATIONS],
    ])).toBe(T_ARMADA_DM_CONVERSATIONS);
  });

  it("does not route unrelated NIP-78 documents by their d-tag prefix", () => {
    expect(queryKeysForSelfEvent(KIND_APP_SPECIFIC, "armada/gif-favorites/device-id"))
      .toEqual([]);
    expect(queryKeysForSelfEvent(KIND_APP_SPECIFIC, "armada/dm-conversations/device-id"))
      .toEqual([]);
  });

  it("routes portable service lists to their owning queries", () => {
    expect(queryKeysForSelfEvent(KIND_SEARCH_RELAYS, undefined))
      .toEqual([["search-relay-list"]]);
    expect(queryKeysForSelfEvent(KIND_DM_RELAYS, undefined))
      .toEqual([["dm-relay-list"]]);
    expect(queryKeysForSelfEvent(KIND_BLOSSOM_SERVERS, undefined))
      .toEqual([["blossom-server-list"]]);
  });

  it("derives relay-change invalidations for fixed, fragmented and topic state", () => {
    expect(SELF_SYNC_OWNER_QUERY_KEYS).toEqual(expect.arrayContaining([
      ["settings-doc", "metadata"],
      ["nip29", "user-groups"],
      ["concord", "list"],
      ["favorite-gifs-sync"],
      ["dm-conversations-sync"],
    ]));
  });
});

describe("admitSelfSyncEvent", () => {
  it.each([
    [10009, undefined],
    [13303, undefined],
    [33302, "7"],
    [KIND_APP_SPECIFIC, "armada/dm-conversations/device/3"],
  ] as const)(
    "applies the lower-id equal-second winner for kind %i",
    (kind, dTag) => {
      const seen = new Map();
      expect(admitSelfSyncEvent(seen, { kind, created_at: 100, id: "bb" }, dTag))
        .toBe(true);
      expect(admitSelfSyncEvent(seen, { kind, created_at: 100, id: "aa" }, dTag))
        .toBe(true);
      expect(admitSelfSyncEvent(seen, { kind, created_at: 100, id: "cc" }, dTag))
        .toBe(false);
    },
  );

  it("keeps addressable coordinates independent", () => {
    const seen = new Map();
    expect(admitSelfSyncEvent(seen, { kind: 33302, created_at: 200, id: "aa" }, "0"))
      .toBe(true);
    expect(admitSelfSyncEvent(seen, { kind: 33302, created_at: 100, id: "zz" }, "1"))
      .toBe(true);
  });
});

describe("NostrSync self-state relay boundary", () => {
  const source = readFileSync("src/components/NostrSync.tsx", "utf8");

  it("never widens private self-state filters to the general pool", () => {
    expect(source).toContain('if (relayUrls.length === 0) return;');
    expect(source).toContain("const source = nostr.group(relayUrls);");
    expect(source).not.toMatch(/nostr\.group\(relayUrls\)\s*:\s*nostr/);
  });
});

/**
 * Android's notification service mirrors the current user's self-state into
 * the same ArmadaDB file while the WebView is dead. Its Kotlin catalogue cannot
 * import this TypeScript one, so compare the source initializers in CI: drift
 * otherwise means a list silently stops following the user between devices on
 * Android-only cold/background runs.
 */
describe("Android SelfState catalogue", () => {
  const kotlin = readFileSync(
    "android/app/src/main/java/buzz/armada/app/db/SelfState.kt",
    "utf8",
  );

  it("matches the WebView's bare self-state kinds exactly", () => {
    const block = kotlin.match(/val KINDS:[^=]*=\s*setOf\(([^)]*)\)/s);
    expect(block, "SelfState.KINDS not found").not.toBeNull();

    const kinds = [...block![1]!.matchAll(/\b(\d+)\b/g)].map((match) => Number(match[1]));
    expect(kinds.sort((a, b) => a - b)).toEqual(
      [...SELF_SYNC_REPLACEABLE_KINDS].sort((a, b) => a - b),
    );
  });

  it("uses the same application-specific kind", () => {
    const value = kotlin.match(/const val KIND_APP_SPECIFIC\s*=\s*(\d+)/)?.[1];
    expect(Number(value)).toBe(KIND_APP_SPECIFIC);
  });

  it("matches the WebView's dynamic document topics exactly", () => {
    const constants = new Map(
      [...kotlin.matchAll(/const val (TOPIC_[A-Z_]+)\s*=\s*"([^"]+)"/g)]
        .map((match) => [match[1]!, match[2]!] as const),
    );
    const block = kotlin.match(/val TOPICS:[^=]*=\s*setOf\(([^)]*)\)/s);
    expect(block, "SelfState.TOPICS not found").not.toBeNull();

    const names = [...block![1]!.matchAll(/TOPIC_[A-Z_]+/g)].map((match) => match[0]);
    expect(names.every((name) => constants.has(name))).toBe(true);
    const topics = names.map((name) => constants.get(name)!);
    expect(topics.sort()).toEqual([...SELF_SYNC_TOPIC_TAGS].sort());
  });
});

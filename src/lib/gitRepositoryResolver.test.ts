import { nip19 } from "nostr-tools";
import type { NostrEvent } from "@nostrify/nostrify";
import { describe, expect, it } from "vitest";

import {
  GIT_ANNOUNCEMENT_DISCOVERY_RELAY,
  resolveGitRepositoryAnnouncement,
  resolveGitRepositoryInput,
} from "./gitRepositoryResolver";

const OWNER = "a".repeat(64);

function announcement(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "b".repeat(64),
    pubkey: OWNER,
    created_at: 10,
    kind: 30617,
    content: "",
    sig: "c".repeat(128),
    tags: [["d", "armada"], ["name", "Armada"], ["relays", "wss://git.example"]],
    ...overrides,
  };
}

describe("resolveGitRepositoryInput", () => {
  it("canonicalizes naddr input and preserves usable relay hints", async () => {
    const naddr = nip19.naddrEncode({ kind: 30617, pubkey: OWNER, identifier: "armada", relays: ["wss://hint.example", "https://bad.example"] });
    await expect(resolveGitRepositoryInput(naddr)).resolves.toEqual({
      address: { kind: 30617, owner: OWNER, identifier: "armada", coordinate: `30617:${OWNER}:armada` },
      relayHints: ["wss://hint.example"],
    });
  });

  it("accepts nostr npub owners and rejects malformed or unsupported input", async () => {
    const npub = nip19.npubEncode(OWNER);
    await expect(resolveGitRepositoryInput(`nostr://${npub}/hello%20world`)).resolves.toMatchObject({
      address: { owner: OWNER, identifier: "hello world", coordinate: `30617:${OWNER}:hello world` },
    });
    await expect(resolveGitRepositoryInput(`nostr://${npub}/`)).rejects.toThrow("identifier");
    await expect(resolveGitRepositoryInput(nip19.naddrEncode({ kind: 30023, pubkey: OWNER, identifier: "post" }))).rejects.toThrow("Only kind-30617");
    await expect(resolveGitRepositoryInput("naddr1notvalid")).rejects.toThrow();
  });

  it("accepts the ngit remote form carrying a relay hint before the identifier", async () => {
    const npub = nip19.npubEncode(OWNER);
    // What `git remote -v` prints for an ngit repo, so it is what a user pastes.
    await expect(resolveGitRepositoryInput(`nostr://${npub}/git.shakespeare.diy/armada`)).resolves.toEqual({
      address: { kind: 30617, owner: OWNER, identifier: "armada", coordinate: `30617:${OWNER}:armada` },
      relayHints: ["wss://git.shakespeare.diy"],
    });
    // Still bounded: a deeper path is not a repository address.
    await expect(resolveGitRepositoryInput(`nostr://${npub}/a/b/armada`)).rejects.toThrow("identifier");
  });
});

describe("resolveGitRepositoryAnnouncement", () => {
  it("queries hints before discovery and keeps the newest exact valid announcement", async () => {
    const calls: string[][] = [];
    const fakeNostr = {
      group: (relays: string[]) => ({
        req: async function* () {
          calls.push(relays);
          if (relays[0]?.includes("hint")) {
            yield ["EVENT", "hint", announcement({ created_at: 5 })];
          } else {
            yield ["EVENT", "discovery", announcement({ created_at: 10, tags: [["d", "armada"], ["name", "New Armada"], ["relays", "wss://activity.example"]] })];
          }
          yield ["EOSE", "done"];
        },
      }),
    };
    const naddr = nip19.naddrEncode({ kind: 30617, pubkey: OWNER, identifier: "armada", relays: ["wss://hint.example"] });
    const result = await resolveGitRepositoryAnnouncement(fakeNostr, naddr);
    expect(calls).toEqual([["wss://hint.example"], [GIT_ANNOUNCEMENT_DISCOVERY_RELAY]]);
    expect(result.announcement.name).toBe("New Armada");
    expect(result.relayHints).toEqual(["wss://activity.example", "wss://hint.example"]);
  });

  it("reports missing announcements and announcements without activity relays", async () => {
    const noEvents = { group: () => ({ req: async function* () { yield ["EOSE", "done"]; } }) };
    const noRelays = { group: () => ({ req: async function* () { yield ["EVENT", "relay", announcement({ tags: [["d", "armada"]] })]; } }) };
    const input = nip19.naddrEncode({ kind: 30617, pubkey: OWNER, identifier: "armada" });
    await expect(resolveGitRepositoryAnnouncement(noEvents, input)).rejects.toThrow("not found");
    await expect(resolveGitRepositoryAnnouncement(noRelays, input)).rejects.toThrow("no usable activity relays");
  });
});
